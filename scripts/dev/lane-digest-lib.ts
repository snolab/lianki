/**
 * The digest layer of lane-listen (docs/lane-listen.md, "Digest mode"; owner,
 * 2026-11-28: "go with 1"). His real-time voice lines used to reach the lanes
 * one at a time. Now each listener buffers his consecutive lines in his own
 * thread and, after a pause, a typed line, a line marked final or a maximum
 * window, flushes them as ONE digest: the polished text and the original ids.
 *
 * - The chat lane (小克) gets every digest and answers it once, with the status.
 * - A lane NAMED in the digest (its name, an alias, @name, 全体) gets the same
 *   digest. A lane that is not named gets nothing: ambient lines that name
 *   nobody never reach a lane other than the chat lane.
 * - A typed line with an explicit @name still goes to that lane at once, on its
 *   own (the bypass), and is not counted again as naming it in the digest.
 *
 * Polish reuses what the hub already does (docs/dev-debug-widget.md,
 * "Automatic polish"): its polish and merges arrive as `edited` events and
 * replace a buffered line's text (a merged passage covers the lines it joined).
 * On top, `tidy` makes a deterministic pass (fillers, stutters, fragments that
 * a later line repeats); no model call of its own. Pure; the timers are
 * injected, so the tests drive them by hand (unit/lane-digest.test.ts).
 */
import { type RouteLane, routeLine } from "../../lib/lane-route";
import { LANES_CONFIG_DEFAULTS } from "../../lib/lanes-config";

/** One of his lines as the digester keeps it. */
export type DigestLine = {
  id: string;
  seq?: number;
  /** The text as it is now (the hub's polish or merge replaces it). */
  text: string;
  /** The text as it first arrived. */
  raw: string;
  /** Typed (source is not "stt"). */
  typed: boolean;
  /** The voiceprint decision, when there was one. */
  voice?: string;
  /** Covered by another line's merged passage or summary: its words are in that line now. */
  covered?: boolean;
  /** Handed to its named lane on its own already (a typed @name line, the bypass). */
  bypass?: boolean;
};

export type DigestReason = "pause" | "max" | "typed" | "final";

/** One flushed run of his lines. */
export type Digest = {
  /** Every original id, in order (covered lines too: the raw lines stay readable by id). */
  ids: string[];
  seqs: (number | undefined)[];
  /** The polished, merged text. */
  text: string;
  lines: DigestLine[];
  reason: DigestReason;
  /** The newest line's time. */
  at?: string;
};

/** The subset of a chat line the digester takes. */
export type DigestInput = {
  id: string;
  text: string;
  seq?: number;
  at?: string;
  /** "stt" for a spoken line; anything else (or absent) is typed. */
  source?: string;
  voice?: string;
};

/** An `edited` event as far as the digest needs it: the new text, and the lines a passage covers. */
export type DigestEdit = { id: string; text: string; covers?: string[] };

export type DigestTimer = {
  set(f: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimer: DigestTimer = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type DigestOpts = {
  /** Flush after this long with no new line (ms). */
  pauseMs: number;
  /** Flush at the latest this long after the first buffered line (ms). */
  maxMs: number;
  /** A line ending in one of these words closes the digest at once. */
  finalWords: readonly string[];
};

// ── Options: env and flags (the Mac-side values of lanes.digest*) ──

/** "Over", "完毕": the words that close a digest when a line ends with them. */
export const DEFAULT_FINAL_WORDS = ["完毕", "说完了", "就这些", "over"] as const;

const truthy = (v: string | undefined): boolean | undefined => {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no"].includes(s)) return false;
  return undefined;
};

/** Is digest mode on: --digest / --no-digest, else LIANKI_LISTEN_DIGEST, else lanes.digest (on). */
export function digestOn(
  flag: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (flag !== undefined) return flag;
  return (
    truthy(env.LIANKI_LISTEN_DIGEST) ??
    truthy(env.LIANKI_LANES_DIGEST) ??
    LANES_CONFIG_DEFAULTS["lanes.digest"]
  );
}

const seconds = (raw: string | undefined, min: number, max: number): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/**
 * The pause, the max window and the final words: flags (seconds) first, then
 * env (LIANKI_LANES_DIGEST_PAUSE_SEC, LIANKI_LANES_DIGEST_MAX_SEC,
 * LIANKI_LANES_DIGEST_FINAL_WORDS comma-separated), then the defaults (8 s, 60 s).
 * A value that does not check out is an Error (from a flag) or the default (env).
 */
export function digestOpts(
  flags: { pauseSec?: string; maxSec?: string } = {},
  env: Record<string, string | undefined> = process.env,
): DigestOpts | Error {
  const d = LANES_CONFIG_DEFAULTS;
  const fromFlag = (raw: string | undefined, min: number, max: number, what: string) => {
    if (raw === undefined) return undefined;
    const v = seconds(raw, min, max);
    return v === undefined
      ? new Error(`lane-listen: ${what} must be ${min}–${max} seconds, got ${JSON.stringify(raw)}`)
      : v;
  };
  const p = fromFlag(flags.pauseSec, 0.5, 120, "--digest-pause");
  if (p instanceof Error) return p;
  const m = fromFlag(flags.maxSec, 1, 600, "--digest-max");
  if (m instanceof Error) return m;
  const pauseSec =
    p ?? seconds(env.LIANKI_LANES_DIGEST_PAUSE_SEC, 0.5, 120) ?? d["lanes.digestPauseSec"];
  const maxSec = m ?? seconds(env.LIANKI_LANES_DIGEST_MAX_SEC, 1, 600) ?? d["lanes.digestMaxSec"];
  const words = (env.LIANKI_LANES_DIGEST_FINAL_WORDS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w && w.length <= 20);
  return {
    pauseMs: Math.round(pauseSec * 1000),
    maxMs: Math.round(Math.max(maxSec, pauseSec) * 1000),
    finalWords: words.length ? words : [...DEFAULT_FINAL_WORDS],
  };
}

// ── The polish pass ──

const END = /[。.!！?？…~～]$/u;
const HAN = /\p{Script=Han}/u;
/** Clause starts: the line's start, or after a mark or a space. */
const CLAUSE = String.raw`(?<=^|[，,。.!！?？、；;：:\s])`;
/** Hesitations that are never words: dropped wherever a clause starts. */
const HESITATION = new RegExp(`${CLAUSE}(?:嗯+|呃+|额+|唔+)[，,、。.\\s]*`, "gu");
/** Fillers that are words elsewhere: dropped only when a mark follows them ("那个，", "就是，", "啊，"). */
const FILLER = new RegExp(`${CLAUSE}(?:那个|就是说?|然后|啊+|哦+|这个)[，,、]\\s*`, "gu");
const FILLER_EN = /\b(?:u+m+|u+h+|e+r+m*|h+m+)\b[,.]?\s*/giu;
/** "the the", "I I": a Latin word said twice in a row. */
const STUTTER_EN = /\b([A-Za-z']+)(?:\s+\1\b)+/giu;
/** "我，我想": one or two Han characters said again across a mark. */
const STUTTER_ZH = /(\p{Script=Han}{1,2})[，,、]\s*\1/gu;

/** One line tidied: hesitations and fillers out, stutters once, spaces and stray marks tidied. Meaning untouched. */
export function tidy(text: string): string {
  let s = text.normalize("NFC").replace(/\s+/gu, " ").trim();
  for (let i = 0; i < 2; i++)
    s = s.replace(HESITATION, "").replace(FILLER, "").replace(FILLER_EN, "");
  s = s.replace(STUTTER_EN, "$1").replace(STUTTER_ZH, "$1");
  return s
    .replace(/^[\s，,、。.；;：:]+/u, "")
    .replace(/[\s，,、；;：:]+$/u, "")
    .replace(/\s+([，,。.!！?？])/gu, "$1")
    .trim();
}

/** Punctuation and spaces out, lower case: two fragments compare as words. */
const bare = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");

/**
 * The digest's text: each line it holds (not the ones a passage covers), tidied,
 * in order; a fragment the next line repeats from its start is dropped (STT
 * sends "我想" then "我想把这个改一下"), so is a line said twice; the rest joined
 * into one passage ("，" between Chinese clauses, ", " or ". " between Latin ones).
 */
export function digestText(lines: readonly DigestLine[], max = 600): string {
  const parts = lines
    .filter((l) => !l.covered)
    .map((l) => tidy(l.text))
    .filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const b = bare(parts[i]!);
    if (!b) continue;
    const next = parts[i + 1] ? bare(parts[i + 1]!) : "";
    if (next && next !== b && next.startsWith(b)) continue;
    if (kept.length && bare(kept.at(-1)!) === b) continue;
    kept.push(parts[i]!);
  }
  let out = "";
  for (const p of kept) {
    if (!out) out = p;
    else if (END.test(out)) out += HAN.test(p[0] ?? "") ? p : ` ${p}`;
    else if (HAN.test(out.at(-1) ?? "") || HAN.test(p[0] ?? "")) out += `，${p}`;
    else out += /^[A-Z]/u.test(p) ? `. ${p}` : `, ${p}`;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ── Who a digest goes to ──

/** The lanes one line names (lane-route.ts, on its text now and as it arrived), and whether it said 全体. */
export function lineNames(l: Pick<DigestLine, "text" | "raw">): {
  lanes: RouteLane[];
  all: boolean;
} {
  const lanes = new Set<RouteLane>();
  let all = false;
  for (const t of new Set([l.raw, l.text])) {
    const r = routeLine(t);
    if (!r.addressed) continue;
    if (r.all) all = true;
    for (const x of r.lanes) lanes.add(x);
  }
  return { lanes: [...lanes], all };
}

/**
 * Where a digest goes for one listening lane (`lane` is its route key, "chat"
 * for 小克): "chat" (the chat lane gets every digest), "named" (a line in it
 * names this lane or says 全体; a bypassed line does not count, it went
 * already; `allow` drops a line this lane may not hear, e.g. an undecided
 * voice), else null: the lane gets nothing.
 */
export function digestRoute(
  lane: RouteLane,
  d: Pick<Digest, "lines">,
  allow: (l: DigestLine) => boolean = () => true,
): "chat" | "named" | null {
  if (lane === "chat") return "chat";
  const named = d.lines.some((l) => {
    if (l.bypass || !allow(l)) return false;
    const n = lineNames(l);
    return n.all || n.lanes.includes(lane);
  });
  return named ? "named" : null;
}

/** The lanes other than `lane` a digest names (for the chat lane's note: those were forwarded). */
export function namedLanes(d: Pick<Digest, "lines">): RouteLane[] {
  const out = new Set<RouteLane>();
  for (const l of d.lines) for (const x of lineNames(l).lanes) out.add(x);
  return [...out];
}

/** Does the line close the digest at once: it ends with a final word ("…，完毕", "over.")? */
export function endsFinal(text: string, words: readonly string[]): boolean {
  // Lower case, the trailing marks and spaces gone; the spaces inside kept for word edges.
  const t = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+$/u, "");
  return words.some((w) => {
    const b = bare(w);
    if (!b || !t.endsWith(b)) return false;
    // A Latin word only as a whole word ("hangover" is not "over").
    const before = t.slice(0, t.length - b.length).at(-1) ?? "";
    return HAN.test(b) || !/[a-z0-9]/u.test(before);
  });
}

/**
 * The buffer. `add` takes each of his lines (owner thread, in order), `edit`
 * each `edited` event, `flush` empties it now. It flushes by itself after
 * `pauseMs` with no new line, at `maxMs` after its first line, and at once on
 * a typed line or a line ending in a final word (that line included).
 * `onFlush` gets each digest; `add` resolves after a flush it caused.
 */
export function makeDigester(
  o: DigestOpts,
  onFlush: (d: Digest) => Promise<void> | void,
  timer: DigestTimer = realTimer,
) {
  let buf: DigestLine[] = [];
  let lastAt: string | undefined;
  let pause: unknown;
  let window: unknown;
  const stop = () => {
    if (pause !== undefined) timer.clear(pause);
    if (window !== undefined) timer.clear(window);
    pause = window = undefined;
  };
  const flush = async (reason: DigestReason): Promise<Digest | undefined> => {
    stop();
    if (!buf.length) return undefined;
    const lines = buf;
    buf = [];
    const d: Digest = {
      ids: lines.map((l) => l.id),
      seqs: lines.map((l) => l.seq),
      text: digestText(lines),
      lines,
      reason,
      ...(lastAt ? { at: lastAt } : {}),
    };
    lastAt = undefined;
    await onFlush(d);
    return d;
  };
  return {
    async add(l: DigestInput, extra: { bypass?: boolean } = {}): Promise<Digest | undefined> {
      if (buf.some((x) => x.id === l.id)) return undefined;
      const typed = l.source !== "stt";
      buf.push({
        id: l.id,
        ...(l.seq !== undefined ? { seq: l.seq } : {}),
        text: l.text,
        raw: l.text,
        typed,
        ...(l.voice ? { voice: l.voice } : {}),
        ...(extra.bypass ? { bypass: true } : {}),
      });
      if (l.at) lastAt = l.at;
      if (typed) return flush("typed");
      if (endsFinal(l.text, o.finalWords)) return flush("final");
      if (pause !== undefined) timer.clear(pause);
      pause = timer.set(() => void flush("pause"), o.pauseMs);
      window ??= timer.set(() => void flush("max"), o.maxMs);
      return undefined;
    },
    /** The hub polished or merged a buffered line: its new text; a passage covers the lines it joined. */
    edit(e: DigestEdit): boolean {
      const line = buf.find((x) => x.id === e.id);
      if (!line || !e.text.trim()) return false;
      line.text = e.text;
      for (const id of e.covers ?? []) {
        if (id === e.id) continue;
        const c = buf.find((x) => x.id === id);
        if (c) c.covered = true;
      }
      return true;
    },
    flush: () => flush("pause"),
    pending: () => buf.length,
    ids: () => buf.map((l) => l.id),
  };
}
export type Digester = ReturnType<typeof makeDigester>;
