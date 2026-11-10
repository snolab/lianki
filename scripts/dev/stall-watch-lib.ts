/**
 * The pure parts of scripts/dev/stall-watch.ts (docs/lane-listen.md, "Stall
 * watch"): reading an agent's terminal tail and telling whether it sits on a
 * permission / confirmation prompt, redacting anything token-like before a
 * line leaves the Mac, and the per-agent state machine that decides when to
 * report and when to clear. No I/O here: the daemon feeds it `ay ls --watch`
 * events and `ay tail` text, and runs the actions it returns.
 */

/**
 * Thresholds, each under a config key (docs/config-store.md). The watcher
 * runs on the Mac, not in the Worker, so the live value is an env var
 * (LIANKI_STALL_<NAME>, e.g. LIANKI_STALL_QUIET_MIN=15) or a flag; these are
 * the defaults.
 */
export const STALL_WATCH_CONFIG = {
  /** A known prompt (Claude "Do you want to…", Codex approval, sudo…) left this long is reported. */
  "stallWatch.promptGraceSec": { env: "LIANKI_STALL_PROMPT_GRACE_SEC", default: 90 },
  /** No output for this long while the screen ends in a question or a choice: reported. */
  "stallWatch.quietMin": { env: "LIANKI_STALL_QUIET_MIN", default: 10 },
  /** After the agent shows output again, wait this long and re-read before clearing. */
  "stallWatch.clearConfirmSec": { env: "LIANKI_STALL_CLEAR_CONFIRM_SEC", default: 20 },
  /** At most one new report per agent in this window (a prompt that flaps). */
  "stallWatch.reportGapSec": { env: "LIANKI_STALL_REPORT_GAP_SEC", default: 300 },
  /** `ay ls --watch --interval`: how often ay diffs its own agent registry. */
  "stallWatch.ayIntervalSec": { env: "LIANKI_STALL_AY_INTERVAL_SEC", default: 5 },
  /** Lines of each tail read. */
  "stallWatch.tailLines": { env: "LIANKI_STALL_TAIL_LINES", default: 40 },
} as const;
export type StallKey = keyof typeof STALL_WATCH_CONFIG;
export type StallConfig = Record<StallKey, number>;

/** The defaults, overridden by a positive number in the key's env var. */
export function stallConfig(env: Record<string, string | undefined> = process.env): StallConfig {
  const out = {} as StallConfig;
  for (const [k, v] of Object.entries(STALL_WATCH_CONFIG) as [
    StallKey,
    (typeof STALL_WATCH_CONFIG)[StallKey],
  ][]) {
    const n = Number(env[v.env]);
    out[k] = env[v.env] !== undefined && Number.isFinite(n) && n > 0 ? n : v.default;
  }
  return out;
}

// ---------------------------------------------------------------- redaction

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:lk|sk|pk|rk)_(?:live_|test_)?[A-Za-z0-9_-]{12,}/g, // lianki, Stripe-style
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / DeepSeek style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, // JWT
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /([?&](?:token|key|secret|sig|signature|code|auth|access_token|password)=)[^&\s"']+/gi,
  /\b((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)["']?[^\s"'&]{4,}/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // e-mail addresses
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex (keys, hashes)
  /\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}/g, // long mixed base64
];

/** Replace anything token-like with "‹redacted›"; keeps the prefix of key=value and ?token= forms. */
export function redact(text: string): string {
  let s = text;
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, ...groups) => {
      const prefix = typeof groups[0] === "string" && m.startsWith(groups[0]) ? groups[0] : "";
      // "Bearer xyz": keep the scheme word.
      if (/^(Bearer|Basic|token)\s/i.test(m)) return `${m.split(/\s+/)[0]} ‹redacted›`;
      return `${prefix}‹redacted›`;
    });
  }
  return s;
}

// ---------------------------------------------------------------- screen

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const BOX_EDGE = /^[\s│┃║|╭╮╰╯┌┐└┘├┤╷╵]+|[\s│┃║|╭╮╰╯┌┐└┘├┤╷╵]+$/g;

/** One terminal line as plain text: no escapes, no box borders, trimmed. */
export function cleanLine(line: string): string {
  return line
    .replace(ANSI, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(BOX_EDGE, "")
    .trim();
}

/** TUI chrome that is on every agent's idle screen and says nothing about a prompt. */
const CHROME: RegExp[] = [
  /^[❯›>]\s*$/, // the empty input line
  /^[❯›>]\s{3,}/, // the empty input line with a side pane's text beyond it
  /^[✻✳✶✢✽·*]\s*\S+…/, // a spinner verb left on screen ("✳ Transfiguring…")
  /\s·\s~\/\S+/, // Codex's model footer ("GPT-… default · ~/ws/… · title")
  /^[❯›]\s+Try "/, // Claude's input placeholder
  /^[─━═\-_~]{3,}/, // separators
  /⏵⏵|auto mode|bypass permissions|accept edits on|plan mode on|shift\+tab/i,
  /^\? for shortcuts|for shortcuts\b/i,
  /new task\? \/clear|\/clear to save/i,
  /Ask Codex to do anything|context left/i,
  /^[✻✳✶✢✽·*⏺•]\s*\S+ (?:for|in) \d+[smh]/, // "✻ Brewed for 45s", "• Worked for 6s"
  /^(?:Worked|Brewed|Churned|Cooked|Baked) for \d/i,
  /^\[pid \d+ /, // ay's own header
  /^ay (?:ls|read|tail|send)\b/, // ay's hints
];
export const isChrome = (l: string) => !l || CHROME.some((re) => re.test(l));

/** A spinner line: the agent is working, not waiting. */
const WORKING = /esc to interrupt|\(esc to cancel[^)]*\d+s|Working \(\d+s/i;

/** Known prompts, by name. Each is tested against one cleaned line near the bottom. */
export const PROMPT_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "claude-permission",
    re: /^Do you want to (?:proceed|make this edit|create|allow|run|overwrite|delete|fetch|use)\b.*\?/i,
  },
  { name: "trust-folder", re: /Do you trust the files in this folder/i },
  {
    name: "codex-approval",
    re: /^(?:Would you like to (?:run|make|apply|allow)\b|Allow (?:Codex|command)\b).*\??/i,
  },
  { name: "menu-yes", re: /^[❯›>]?\s*1\.\s+Yes\b/ },
  { name: "approve-deny", re: /\b(?:approve|deny|allow)\b.*\((?:y|a|n|esc)\)\s*$/i },
  { name: "sudo", re: /^\[sudo\] password for |^Password:\s*$|^sudo: a password is required/i },
  { name: "passphrase", re: /Enter passphrase for|password to unlock|Enter PIN for/i },
  {
    name: "keychain",
    re: /wants to (?:use|access|sign using) .*(?:keychain|confidential information)/i,
  },
  {
    name: "y-n",
    re: /(?:\[(?:y\/n|Y\/n|y\/N|yes\/no)\]|\((?:y\/n|Y\/n|y\/N|yes\/no)\))\s*[:?]?\s*$/,
  },
  { name: "press-enter", re: /press (?:enter|return|any key) to (?:continue|proceed|confirm)/i },
];

/** How far up from the bottom a prompt may sit (old prompts scroll up and stop counting). */
const PROMPT_WINDOW = 14;
/** How far up from the bottom the question heuristic looks. */
const QUESTION_WINDOW = 4;

export type Verdict =
  | { kind: "prompt"; pattern: string; line: string }
  | { kind: "question"; line: string }
  | null;

/** The meaningful lines of a tail (chrome dropped), oldest first. */
export function screenLines(tail: string): string[] {
  return tail
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((l) => !isChrome(l));
}

/** The line a report quotes: the question above a menu if there is one, else the matched line. */
function headline(lines: string[], i: number): string {
  const near = lines.slice(Math.max(0, i - 6), i + 1).reverse();
  return near.find((l) => /[?？]\s*$/.test(l)) ?? near.find((l) => /[?？]/.test(l)) ?? lines[i]!;
}

/**
 * Does this screen sit on a prompt? "prompt": a known prompt within the
 * bottom lines; "question": the last lines end in "?" / "？" (reported only
 * after the quiet time); null: neither, or a spinner says it is working.
 */
export function classifyScreen(tail: string): Verdict {
  // A spinner near the bottom (before chrome is dropped): working, not waiting.
  const raw = tail.split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (raw.slice(-8).some((l) => WORKING.test(l))) return null;
  const lines = screenLines(tail);
  if (lines.length === 0) return null;
  const bottom = lines.slice(-PROMPT_WINDOW);
  for (let i = bottom.length - 1; i >= 0; i--) {
    const p = PROMPT_PATTERNS.find((p) => p.re.test(bottom[i]!));
    if (p) return { kind: "prompt", pattern: p.name, line: headline(bottom, i) };
  }
  const last = lines.slice(-QUESTION_WINDOW);
  for (let i = last.length - 1; i >= 0; i--)
    if (/[?？]\s*[)）*_`"”」]*\s*$/.test(last[i]!)) return { kind: "question", line: last[i]! };
  return null;
}

/** A stable fingerprint of what the screen shows (chrome dropped), to tell "unchanged". */
export function screenHash(tail: string): string {
  return String(Bun.hash(screenLines(tail).join("\n")));
}

// ---------------------------------------------------------------- lanes

/** "~/ws/snolab/lianki/tree/codex" → "codex"; elsewhere the last path part. */
export function laneOf(cwd: string): string {
  const m = /\/tree\/([^/]+)/.exec(cwd);
  const raw = m ? m[1]! : (cwd.replace(/\/+$/, "").split("/").at(-1) ?? "agent");
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

/** Columns a string takes (CJK and emoji are 2), as lib/progress.ts displayWidth. */
function cols(s: string): number {
  let n = 0;
  for (const ch of s)
    n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return n;
}

export type Report = { path: string; task: string; who: string; needs: string };

/**
 * The blocked node for one agent: /infra/agent-stall-watch/<lane>-<pid>, a
 * name of at most 20 columns, `who` = the coordinating lane (the owner when
 * the coordinator itself is the one stuck), `needs` ≤ 120 chars, redacted.
 */
export function reportFor(
  a: { pid: number; cwd: string; cli: string },
  v: NonNullable<Verdict>,
  coordinator = "main",
): Report {
  const lane = laneOf(a.cwd);
  let short = lane;
  while (cols(`${short} 等确认`) > 20) short = short.slice(0, -1);
  const what = v.kind === "prompt" ? "waits on a prompt" : "waits on a question";
  const line = redact(v.line).replace(/\s+/g, " ");
  const head = `${lane} ${what}: `;
  const needs = (head + line).length > 120 ? `${(head + line).slice(0, 119)}…` : head + line;
  return {
    path: `/infra/agent-stall-watch/${lane}-${a.pid}`,
    task: `${short} 等确认: ${a.cli} pid ${a.pid} ${what}`,
    who: lane === coordinator ? "owner" : coordinator,
    needs,
  };
}

// ---------------------------------------------------------------- state machine

export type AgentState = "active" | "idle" | "needs_input" | "stuck" | "stopped" | "exited";
export type AyEvent = {
  ts: number;
  pid: number;
  cli: string;
  cwd: string;
  state: AgentState | string;
  question?: string | null;
};

/** What the daemon does next for one agent. */
export type Action =
  | { do: "read"; pid: number; why: "settled" | "grace" | "quiet" | "clear" }
  | { do: "timer"; pid: number; ms: number; why: "grace" | "quiet" | "clear" | "gap" }
  | { do: "cancel"; pid: number }
  | { do: "report"; pid: number; report: Report; verdict: NonNullable<Verdict> }
  | { do: "clear"; pid: number; path: string; why: string };

type Track = {
  ev: AyEvent;
  hash?: string;
  verdict?: Verdict;
  reported?: { path: string; line: string; at: number };
  lastReportAt?: number;
};

/**
 * One agent's watch, driven by ay's state events, tail reads and timers.
 * Reads happen only on an edge (the agent stopped printing, a timer for
 * that edge fired); nothing runs on a schedule of its own.
 */
export class StallTracker {
  private t = new Map<number, Track>();
  constructor(
    private cfg: StallConfig,
    private coordinator = "main",
  ) {}

  /** An `ay ls --watch` line. */
  onEvent(ev: AyEvent): Action[] {
    const prev = this.t.get(ev.pid);
    const tr: Track = prev ?? { ev };
    tr.ev = ev;
    this.t.set(ev.pid, tr);
    if (ev.state === "stopped" || ev.state === "exited") {
      this.t.delete(ev.pid);
      const out: Action[] = [{ do: "cancel", pid: ev.pid }];
      if (tr.reported)
        out.push({ do: "clear", pid: ev.pid, path: tr.reported.path, why: "agent exited" });
      return out;
    }
    if (ev.state === "active") {
      // Output moved: drop pending timers; a reported stall is re-read shortly before clearing.
      const out: Action[] = [{ do: "cancel", pid: ev.pid }];
      if (tr.reported)
        out.push({
          do: "timer",
          pid: ev.pid,
          ms: this.cfg["stallWatch.clearConfirmSec"] * 1000,
          why: "clear",
        });
      return out;
    }
    // idle / stuck / needs_input: the screen stopped moving. Look once.
    return [
      { do: "cancel", pid: ev.pid },
      { do: "read", pid: ev.pid, why: "settled" },
    ];
  }

  /** The tail read for `why`. */
  onTail(
    pid: number,
    why: "settled" | "grace" | "quiet" | "clear",
    tail: string,
    now = Date.now(),
  ): Action[] {
    const tr = this.t.get(pid);
    if (!tr) return [];
    const hash = screenHash(tail);
    let v = classifyScreen(tail);
    // ay's own needs_input reading counts as a prompt when our patterns miss it.
    if (!v && tr.ev.state === "needs_input" && tr.ev.question)
      v = { kind: "prompt", pattern: "ay-needs-input", line: tr.ev.question.split(/\s+•\s+/)[0]! };
    const moving = tr.ev.state === "active";

    if (why === "clear") {
      if (!tr.reported) return [];
      if (!v || v.line !== tr.reported.line) {
        const path = tr.reported.path;
        tr.reported = undefined;
        tr.verdict = undefined;
        return [{ do: "clear", pid, path, why: "screen moved on" }];
      }
      return []; // same prompt still showing: keep it; the next idle edge re-checks.
    }

    if (why === "settled") {
      tr.hash = hash;
      tr.verdict = v;
      if (!v) {
        if (!tr.reported) return [];
        const path = tr.reported.path;
        tr.reported = undefined;
        return [{ do: "clear", pid, path, why: "screen moved on" }];
      }
      if (tr.reported && tr.reported.line === v.line) return []; // already told
      const ms =
        v.kind === "prompt"
          ? this.cfg["stallWatch.promptGraceSec"] * 1000
          : this.cfg["stallWatch.quietMin"] * 60_000;
      return [{ do: "timer", pid, ms, why: v.kind === "prompt" ? "grace" : "quiet" }];
    }

    // grace / quiet (or gap) fired: still the same screen, still not moving?
    if (moving || !v || hash !== tr.hash || !tr.verdict || v.line !== tr.verdict.line) {
      tr.hash = hash;
      tr.verdict = v;
      return [];
    }
    if (tr.reported && tr.reported.line === v.line) return [];
    const gap = this.cfg["stallWatch.reportGapSec"] * 1000;
    if (tr.lastReportAt !== undefined && now - tr.lastReportAt < gap)
      return [{ do: "timer", pid, ms: gap - (now - tr.lastReportAt), why: "gap" }];
    const report = reportFor(tr.ev, v, this.coordinator);
    tr.reported = { path: report.path, line: v.line, at: now };
    tr.lastReportAt = now;
    return [{ do: "report", pid, report, verdict: v }];
  }

  /** A timer this tracker asked for has fired. */
  onTimer(pid: number, why: "grace" | "quiet" | "clear" | "gap"): Action[] {
    if (!this.t.has(pid)) return [];
    return [{ do: "read", pid, why: why === "gap" ? "grace" : why }];
  }

  /** The agents with a stall reported, for the daemon's shutdown and logs. */
  reported(): { pid: number; path: string }[] {
    return [...this.t.entries()]
      .filter(([, t]) => t.reported)
      .map(([pid, t]) => ({ pid, path: t.reported!.path }));
  }
}

/** One `ay ls --watch` line as an event, or null (its banner, a blank, junk). */
export function parseAyLine(line: string): AyEvent | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const o = JSON.parse(s) as Partial<AyEvent>;
    if (typeof o.pid !== "number" || typeof o.state !== "string" || typeof o.cwd !== "string")
      return null;
    return {
      ts: o.ts ?? Date.now(),
      pid: o.pid,
      cli: o.cli ?? "agent",
      cwd: o.cwd,
      state: o.state,
      question: o.question ?? null,
    };
  } catch {
    return null;
  }
}

/** Open stall nodes left by an earlier run (`progress.ts show --json`), to close at start. */
export function staleNodes(show: unknown): { id: string; task: string }[] {
  const entries = (show as { entries?: unknown[] } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((e) => {
    const n = e as { id?: unknown; task?: unknown; status?: unknown; creator?: unknown };
    return typeof n.id === "string" &&
      n.id.startsWith("/infra/agent-stall-watch/") &&
      n.creator === "stall-watch" &&
      n.status !== "done" &&
      typeof n.task === "string"
      ? [{ id: n.id, task: n.task }]
      : [];
  });
}
