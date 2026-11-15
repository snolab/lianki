/**
 * The pure half of ./lane-listen.ts (docs/lane-listen.md): where a lane's
 * token comes from (never printed), reading both listeners' JSON lines, and
 * what the lane's agent is handed. Tested in unit/lane-listen.test.ts.
 */
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RouteLane, laneOfRoute, routeLine, testText } from "../../lib/lane-route";
import { laneSpec } from "../../packages/debug-chat/src/voices";
import { ownerClock, ownerTag } from "./owner-time";

/** Where a lane's token is kept on this Mac. */
export const laneTokenDir = (env: Record<string, string | undefined> = process.env) =>
  env.LIANKI_LANE_TOKEN_DIR || join(homedir(), ".config", "lianki", "lanes");
export const laneTokenPath = (lane: string, env?: Record<string, string | undefined>) =>
  join(laneTokenDir(env), `${lane}.token`);

/**
 * The lane's token: LIANKI_TOKEN, else its file. The file must be the owner's
 * alone (no group or other bits) and hold one lk_ token. Never logged.
 */
export function laneToken(
  lane: string | undefined,
  env: Record<string, string | undefined> = process.env,
): { token: string; from: "env" | "file" } | { token?: undefined; from: "none"; why: string } {
  const e = env.LIANKI_TOKEN?.trim();
  if (e) return { token: e, from: "env" };
  if (!lane || !/^[A-Za-z0-9._-]{1,40}$/.test(lane) || lane.includes(".."))
    return { from: "none", why: "no lane (--as) to look a token up for" };
  const path = laneTokenPath(lane, env);
  // One open file: its mode and its contents are the same file's.
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { from: "none", why: `no token file ${path}` };
  }
  let t: string;
  try {
    if (fstatSync(fd).mode & 0o077)
      return { from: "none", why: `${path} is readable by others: chmod 600 it` };
    t = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
  if (!/^lk_[A-Za-z0-9_-]{16,}$/.test(t))
    return { from: "none", why: `${path} does not hold an lk_ token` };
  return { token: t, from: "file" };
}

/** What the owner makes at lianki.com/my/preferences → API tokens for `lane`. */
export const tokenNeeded = (lane: string, env?: Record<string, string | undefined>) =>
  `a lane token for ${lane}: lianki.com/my/preferences → API tokens → name "${lane}", permissions chat:read chat:write chat:ask (nothing else), an expiry; saved at ${laneTokenPath(lane, env)} (chmod 600) or passed as LIANKI_TOKEN`;

/** A chat line from either listener's JSON (eval.ts chat, or `lianki chat listen --json`). */
export type Line = {
  id: string;
  thread: string;
  from: string;
  text: string;
  at?: string;
  /** An automatic state-tree line (source "eta") addressed to this lane: a blocked nudge, or "main". */
  etaLane?: string;
  /** The Mac's voiceprint decision on a spoken owner line: "me" | "other" | "unknown" (absent: typed, or no print). */
  voice?: string;
};
/**
 * Whether a lane may hear this owner line (owner, 2026-11-14 23:2x: "只有我自己的
 *语音才广播给所有 agent"): a line the voiceprint decided was someone else never
 * goes out; an "unknown" one (his own short or soft sentence) does, marked, unless
 * LANE_LISTEN_VOICES=me asks for his decided voice only. The chat lane still
 * sees every line (it polishes and answers in the thread).
 */
export function voiceAllowed(
  l: Pick<Line, "from" | "voice">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (l.from !== "owner" || !l.voice) return true;
  if (l.voice === "other") return false;
  if (l.voice === "unknown") return env.LANE_LISTEN_VOICES !== "me";
  return true;
}
export function lineOf(raw: string): (Line & { history: boolean }) | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || v.type !== "chat") return null;
  const m = (v.message && typeof v.message === "object" ? v.message : v) as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.text !== "string") return null;
  return {
    id: m.id,
    thread: typeof m.thread === "string" ? m.thread : "owner",
    from: typeof m.from === "string" ? m.from : "",
    text: m.text,
    ...(m.source === "eta" &&
    m.from === "agent" &&
    m.eta &&
    typeof (m.eta as { lane?: unknown }).lane === "string"
      ? { etaLane: (m.eta as { lane: string }).lane }
      : {}),
    ...(m.at !== undefined
      ? { at: String(typeof m.at === "number" ? new Date(m.at).toISOString() : m.at) }
      : {}),
    ...(m.speaker &&
    typeof m.speaker === "object" &&
    typeof (m.speaker as { decision?: unknown }).decision === "string"
      ? { voice: (m.speaker as { decision: string }).decision }
      : {}),
    history: v.history === true,
  };
}

/** "HH:MM TAG" in the machine's zone (or LIANKI_OWNER_TZ), e.g. "01:06 JST"; now for a bad time. */
export const ownerAt = (at?: string) => {
  const d = at ? new Date(at) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${ownerClock(t)} ${ownerTag(t)}`;
};

/**
 * The rule every lane hears (owner, 2026-11-15 15:0x JST: "我在 @ 你的时候，这些只读
 * AI（包括 mimiai）不要乱回复"): answer only a line that names you or 全体.
 */
export const NO_CROSS_RULE = "只回答点名我或「全体」的话；被点名的是别人时不插话、不代答、不追问。";

/** Whom a line is for, as `lane` sees it: "mine" (its name or 全体), "other" (another lane's name), or "none". */
export function addressee(
  lane: RouteLane,
  text: string,
): { to: "mine" } | { to: "other"; names: string[] } | { to: "none" } {
  const r = routeLine(text);
  if (!r.addressed) return { to: "none" };
  if (r.all || r.lanes.includes(lane)) return { to: "mine" };
  return { to: "other", names: r.lanes.map((x) => laneSpec(laneOfRoute(x)).name || x) };
}

/** The marker in front of a line he addressed to another lane by name. */
export const otherMark = (names: readonly string[]) => `【FYI · 点名 ${names.join("、")}，不是你】`;
/** Once per batch that holds such a line: what to do with it. */
export const OTHER_NOTE = "点名别人的：不要回答、不要代做；只在点名你或 全体 时回复。";
/** Once per batch that holds a line with no name (a listen-to-all lane). */
export const NONE_NOTE = "未点名：只听，不回。";

/** What the lane's agent is handed: his words, and how to answer as itself. */
export function handoff(lane: RouteLane, l: Line, repo: string): string {
  if (l.etaLane === lane)
    return [
      `【state tree → ${lane}】(${ownerAt(l.at)}, automatic) ${l.text}`,
      "",
      'The state tree\'s hub sent this to your lane (docs/state-tree.md, "Blocked and paused", "Receipts"). Act on it; report on the node with bun scripts/dev/progress.ts, or answer in Li with:',
      `  bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} say --repo ${repo} --as ${lane} "<your reply>"`,
    ].join("\n");
  const test = testText(l);
  const words = test ?? l.text;
  const said = addressee(lane, words);
  const reply = `bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} say --repo ${repo} --as ${lane} "<your reply>"`;
  return [
    test === null
      ? `【owner → ${lane}】(${ownerAt(l.at)}, Li chat) ${words}`
      : `【lane-test → ${lane}】(${ownerAt(l.at)}) ${words}`,
    "",
    test !== null
      ? 'This is a routing TEST, not the owner. Answer once, starting "[lane-test] ", one short line, so the test sees you heard it:'
      : said.to === "mine"
        ? `He addressed this to you by name; only you got it, the other lanes stay silent. Answer once, yourself, short, in his language${routeLine(words).text ? "" : " (he only said your name: ask what he needs)"}:`
        : said.to === "other"
          ? `${otherMark(said.names)} He addressed this to another lane by name: do not answer, do not do it for them, do not follow up. ${OTHER_NOTE} Only if he names you or 全体 later:`
          : `${NONE_NOTE} Heard, not addressed to you by name (you listen to all his lines): keep it as context and stay silent; another lane answers. Only if he names you or 全体:`,
    `  ${reply}`,
    "It posts as your lane (your name, mark and voice) with your own lane token; never read or print the token. Do not hand this to another lane.",
  ].join("\n");
}

/** The skill every lane's agent reads once; after that the hand-offs stay short. */
export const HANDOFF_SKILL = ".agents/skills/lane-listen/SKILL.md";

/**
 * One owner line as a bullet of a brief hand-off: the id to answer with, "@你"
 * when he said this lane's name (lane-route.ts), then his words (owner,
 * 2026-11-14: every short line used to arrive as its own long message with the
 * whole instruction block; the instructions now live in HANDOFF_SKILL).
 */
export function briefBullet(lane: RouteLane, l: Line): string {
  if (l.etaLane === lane) return `- (state tree) ${l.text}`;
  const test = testText(l);
  if (test !== null) return `- (id:${l.id}) [lane-test] ${test}`;
  const to = addressee(lane, l.text);
  const mark = to.to === "mine" ? " @你" : to.to === "other" ? ` ${otherMark(to.names)}` : "";
  const unsure = l.voice === "unknown" ? "（声纹未定）" : "";
  return `- (id:${l.id})${mark}${unsure} ${l.text}`;
}

/** The notes a batch carries once each: OTHER_NOTE when a line names another lane, NONE_NOTE when one names nobody. */
export function batchNotes(lane: RouteLane, lines: readonly Line[]): string[] {
  const kinds = new Set(
    lines
      .filter((l) => l.etaLane !== lane && testText(l) === null)
      .map((l) => addressee(lane, l.text).to),
  );
  return [...(kinds.has("other") ? [OTHER_NOTE] : []), ...(kinds.has("none") ? [NONE_NOTE] : [])];
}

/**
 * A brief hand-off for one or more lines (several when the agent was busy and
 * they waited): a header with the lane and the newest line's time, one bullet
 * per line, and — only the first time in this listener's life — where the
 * rules are. ~2 lines per message instead of ~8.
 */
export function handoffBrief(
  lane: RouteLane,
  lines: readonly Line[],
  repo: string,
  first: boolean,
): string {
  const at = ownerAt(lines.at(-1)?.at);
  const out = [
    `【owner → ${lane}】${at}`,
    ...batchNotes(lane, lines),
    ...lines.map((l) => briefBullet(lane, l)),
  ];
  if (first) out.push(...firstLines(lane, repo));
  return out.join("\n");
}

/** What only the first message of a listener's (or a woken reader's) life carries: the rule, and where the rules are. */
export const firstLines = (lane: RouteLane, repo: string) => [
  NO_CROSS_RULE,
  `规则只读这一次：${join(repo, HANDOFF_SKILL)}（回复：bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} reply --as ${lane} --id <id> "…"）`,
];

/** How often a busy agent is looked at while lines wait for it. */
export const BUSY_RECHECK_MS = 5_000;

/**
 * Lines wait here while the agent is busy; when it is free they go as ONE
 * message (handoffBrief), in order. The first message of the listener's life
 * also names the skill with the rules.
 */
/**
 * A line that must reach the lane now, even mid-turn: he said this lane's name
 * or "全体" (lane-route.ts), or a state-tree nudge is addressed to it (owner,
 * 2026-11-14 22:5x: "coco和杰米好像干活的时候都不理我"). Everything else waits
 * for the batch.
 */
export const urgentLine = (lane: RouteLane, l: Line) => {
  if (l.etaLane === lane) return true;
  return addressee(lane, l.text).to === "mine";
};
/** The body `ay send` still accepts: its own 1024 limit minus its ~150-char wrapper, with room for the header and the skill line. */
export const SEND_MAX_CHARS = 800;
/** A batch cut into parts whose bullets (and their batch notes) stay under SEND_MAX_CHARS; one bullet too long on its own is cut with "…". */
export function chunkLines(
  lane: RouteLane,
  lines: readonly Line[],
  max = SEND_MAX_CHARS,
): Line[][] {
  const parts: Line[][] = [];
  let cur: Line[] = [];
  let size = 0;
  const notes = (ls: readonly Line[]) => batchNotes(lane, ls).reduce((n, x) => n + x.length + 1, 0);
  for (const l of lines) {
    let line = l;
    const room = max - notes([l]);
    let len = briefBullet(lane, line).length + 1;
    if (len > room) {
      const over = len - room + 1;
      line = { ...l, text: `${l.text.slice(0, Math.max(0, l.text.length - over))}…` };
      len = briefBullet(lane, line).length + 1;
    }
    if (cur.length && size + len + notes([...cur, line]) > max) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += len;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
export function makeDeliverer(
  o: { lane: RouteLane; repo: string },
  send: (body: string, interrupt: boolean) => Promise<number>,
  busy: () => Promise<boolean>,
  log: (v: Record<string, unknown>) => void = () => {},
  recheckMs = BUSY_RECHECK_MS,
) {
  const pending: Line[] = [];
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async (interrupt = false): Promise<number | undefined> => {
    if (!pending.length) return undefined;
    if (!interrupt && (await busy())) {
      if (process.env.LANE_LISTEN_DEBUG)
        log({ type: "held", lane: o.lane, pending: pending.length });
      timer ??= setTimeout(() => {
        timer = undefined;
        void flush();
      }, recheckMs);
      return undefined;
    }
    const batch = pending.splice(0, pending.length);
    // `ay send` refuses a message over 1024 characters (its wrapper takes ~150),
    // and a refused batch was simply lost (2026-11-14 23:xx, four of coco's).
    // So a long batch goes as several messages, each under SEND_MAX_CHARS.
    let code: number | undefined;
    // The first message also carries firstLines: its parts leave room for them.
    const room = SEND_MAX_CHARS - (first ? firstLines(o.lane, o.repo).join("\n").length + 1 : 0);
    for (const part of chunkLines(o.lane, batch, room)) {
      code = await send(handoffBrief(o.lane, part, o.repo, first), interrupt);
      first = false;
      log({ type: "delivered", lane: o.lane, ids: part.map((l) => l.id), interrupt, ay: code });
      if (code !== 0 && code !== 4)
        log({ type: "lost", lane: o.lane, ids: part.map((l) => l.id), ay: code });
    }
    return code;
  };
  return {
    add: async (l: Line) => {
      pending.push(l);
      return flush(urgentLine(o.lane, l));
    },
    pending: () => pending.length,
  };
}

/** A listener that ran this long was a good connection: its next reconnect starts quick again. */
export const RECONNECT_RESET_MS = 60_000;

/**
 * The wait before the next reconnect, and the one after it. A socket that
 * lived RECONNECT_RESET_MS or more starts again at 1 s, so a drop after a
 * quiet night reconnects inside the hub's grace (lanes.modeGraceSec, 30 s)
 * and no "转为只读" is said; quick failures back off to 60 s (10 min on 5,
 * a refusal).
 */
export function reconnectWait(
  backoff: number,
  code: number,
  ranMs: number,
): { wait: number; next: number } {
  const wait = ranMs >= RECONNECT_RESET_MS ? 1_000 : backoff;
  return { wait, next: Math.min(wait * 2, code === 5 ? 600_000 : 60_000) };
}
