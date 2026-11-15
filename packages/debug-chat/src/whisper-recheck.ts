/**
 * Whisper re-listens to a whole continuous-speech run (owner, 2026-11-15 03:17 JST:
 * "用 Whisper 整段重听 … 作为第二步 polish"). Three readings of his speech:
 *
 * 1. the streaming STT (SenseVoice on his Mac), part by part, merged into one line;
 * 2. when the run ends (the passage end, voice-merge.ts PASSAGE_END_MS), the Mac's
 *    Whisper re-reads the run's whole audio, kept in its RAM ring for the socket
 *    (scripts/local-stt/server.py `run_audio`), and the line takes that text;
 * 3. the polish (the hub's automatic one, or a lane's) then reads the Whisper text.
 *
 * The page asks the Mac (recheckPlan), checks the answer still fits the line
 * (recheckAmend), and sends it with the passage end, so the hub amends the line
 * before it settles it and the one polish of the run reads level 2. The hub
 * checks it again (applyRecheck). Flag `stt.whisper-recheck`; config
 * `stt.recheckMinSec`, `stt.recheckMaxSec`, `stt.recheckTimeoutMs`.
 * docs/dev-debug-widget.md, "Whisper re-listens to the whole run".
 *
 * Pure and free of the DOM: the push Worker imports it.
 */
import { MERGE_BY, joinParts } from "./voice-merge";
import { type ChatMessage, MAX_CHAT, type RecheckMark } from "./wire";

/** The engine the Mac re-reads with (server.py `recheck`). */
export const RECHECK_ENGINE = "mlx-whisper";

/** What the page was given (app/layout.tsx, from the flag and lib/config.ts). */
export type RecheckConf = {
  /** Flag stt.whisper-recheck. */
  on: boolean;
  /** stt.recheckMinSec: a shorter run is not re-read. */
  minSec: number;
  /** stt.recheckMaxSec: a longer run is re-read only in its newest parts (the Mac's ring holds no more). */
  maxSec: number;
  /** stt.recheckTimeoutMs: how long the passage end waits for the Mac. */
  timeoutMs: number;
};

/** The request to the Mac (server.py, `{"t":"recheck","auto":true,…}`); `rid` is added by request(). */
export type RecheckRequest = {
  t: "recheck";
  auto: true;
  engine: typeof RECHECK_ENGINE;
  run: string;
  fromAgoMs: number;
  toAgoMs: number;
};

/**
 * A run to re-read: which line, as it read when asked, and `from`, the first part
 * re-read (0: all of it; more when the run is longer than stt.recheckMaxSec, a
 * reopened line's for instance: the parts before it keep the streaming text).
 */
export type RecheckPlan = {
  run: string;
  parts: number;
  text: string;
  from: number;
  msg: RecheckRequest;
};

/** What the page sends with its passage end, and the hub checks again. `from` as in RecheckPlan, absent = 0. */
export type RecheckAmend = {
  id: string;
  parts: number;
  text: string;
  engine: string;
  lang?: string;
  from?: number;
};

const ENGINE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const LINE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Why a merged line still takes a level-2 reading, or undefined: it is the run
 * as the merge left it — not settled, not re-read yet, not polished or edited
 * by anyone since, not made a passage or folded into one.
 */
function closed(line: ChatMessage): string | undefined {
  if (!line.parts || line.parts.length < 2) return "not-merged";
  if (line.settled || line.passage || line.summary || line.collapsedInto) return "closed";
  if (line.recheck) return "done";
  if ((line.edited && line.edited.by !== MERGE_BY) || (line.raw ?? line.text) !== line.text)
    return "edited";
  return undefined;
}

/**
 * The run to re-read for this line (the page's newest owner line, at its passage
 * end), or why not. Its window is read from the parts' own timing, on this page's
 * clock, and sent as durations before now, so the Mac's clock never has to agree.
 */
export function recheckPlan(
  line: ChatMessage | undefined,
  now: number,
  conf: RecheckConf,
): RecheckPlan | { skip: string } {
  if (!conf.on) return { skip: "off" };
  if (!line) return { skip: "no-line" };
  const no = closed(line);
  if (no) return { skip: no };
  const parts = line.parts!;
  if (parts.some((p) => p.timing?.t_speechStart === undefined || p.timing.t_speechEnd === undefined))
    return { skip: "no-timing" };
  const end = parts.at(-1)!.timing!.t_speechEnd!;
  if (end < parts[0].timing!.t_speechStart!) return { skip: "no-timing" };
  // The newest parts that fit in stt.recheckMaxSec, from the first one's start to the
  // last one's end on the wall clock. The ring holds only what was streamed, so the
  // wall span is never less than what it must hold: what fits here is in the ring.
  const from = parts.findIndex((p) => (end - p.timing!.t_speechStart!) / 1000 <= conf.maxSec);
  if (from < 0) return { skip: "long" };
  // Every part re-read from the Mac: the cloud's parts were never in its ring.
  if (parts.slice(from).some((p) => p.stt?.route !== "local")) return { skip: "not-local" };
  const start = parts[from].timing!.t_speechStart!;
  if ((end - start) / 1000 < conf.minSec) return { skip: "short" };
  if (now < end) return { skip: "no-timing" };
  return {
    run: line.id,
    parts: parts.length,
    text: line.text,
    from,
    msg: {
      t: "recheck",
      auto: true,
      engine: RECHECK_ENGINE,
      run: line.id,
      fromAgoMs: Math.round(now - start),
      toAgoMs: Math.round(now - end),
    },
  };
}

/**
 * The Mac's answer as an amend of the line, or undefined: a failure, another run's
 * answer, nothing read, or a line that moved on while Whisper read (a part joined,
 * a polish, the owner's undo): then the line keeps level 1.
 */
export function recheckAmend(
  plan: RecheckPlan,
  res: Record<string, unknown> | undefined,
  line: ChatMessage | undefined,
): RecheckAmend | undefined {
  if (!res || res.ok !== true || res.auto !== true || res.run !== plan.run) return undefined;
  const text = typeof res.text === "string" ? res.text.trim() : "";
  if (!text || text.length > MAX_CHAT) return undefined;
  if (!line || line.id !== plan.run || closed(line)) return undefined;
  if (line.parts!.length !== plan.parts || line.text !== plan.text) return undefined;
  const engine =
    typeof res.engine === "string" && ENGINE.test(res.engine) ? res.engine : RECHECK_ENGINE;
  return {
    id: plan.run,
    parts: plan.parts,
    text,
    engine,
    ...(typeof res.lang === "string" && LANG.test(res.lang) ? { lang: res.lang } : {}),
    ...(plan.from > 0 ? { from: plan.from } : {}),
  };
}

/** A RecheckAmend from the wire (the page's passage end), or undefined: known keys only, each checked. */
export function cleanRecheckAmend(raw: unknown): RecheckAmend | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !LINE_ID.test(r.id)) return undefined;
  if (typeof r.parts !== "number" || !Number.isInteger(r.parts) || r.parts < 2) return undefined;
  if (typeof r.text !== "string" || !r.text.trim() || r.text.length > MAX_CHAT) return undefined;
  if (typeof r.engine !== "string" || !ENGINE.test(r.engine)) return undefined;
  const from = r.from ?? 0;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 0 || from >= r.parts)
    return undefined;
  return {
    id: r.id,
    parts: r.parts,
    text: r.text.trim(),
    engine: r.engine,
    ...(typeof r.lang === "string" && LANG.test(r.lang) ? { lang: r.lang } : {}),
    ...(from > 0 ? { from } : {}),
  };
}

/**
 * The hub's side: the line with Whisper's reading, or why it stays as it is. The
 * same checks as the page's, on the stored line: the run's line, as many parts,
 * and nobody's edit since. The streaming text stays in `recheck.heard` and in the
 * parts; the undo still splits it back into the parts as heard.
 */
export function applyRecheck(
  line: ChatMessage,
  a: RecheckAmend,
  at: number,
): ChatMessage | string {
  if (line.id !== a.id) return "other-line";
  const no = closed(line);
  if (no) return no;
  if (line.parts!.length !== a.parts) return "parts-changed";
  // Only the newest parts were re-read: the ones before keep what was heard (level 1).
  const from = a.from ?? 0;
  if (!Number.isInteger(from) || from < 0 || from >= a.parts) return "bad-from";
  const text = [...line.parts!.slice(0, from).map((p) => p.text), a.text].reduce(joinParts);
  if (text.length > MAX_CHAT) return "long";
  const mark: RecheckMark = {
    at,
    engine: a.engine,
    ...(a.lang ? { lang: a.lang } : {}),
    heard: line.text,
    text,
    ...(from > 0 ? { from } : {}),
  };
  return {
    ...line,
    text,
    raw: text,
    recheck: mark,
    edited: { at, by: MERGE_BY, count: line.edited?.count ?? 0 },
  };
}

/** The three readings of a line for the details panel (MessageDetails.tsx), or undefined for a plain line. */
export function readingsOf(
  line: Pick<ChatMessage, "text" | "raw" | "edited" | "recheck">,
): { heard: string; whisper: { text: string; engine: string }; polished?: string } | undefined {
  const r = line.recheck;
  if (!r) return undefined;
  // Level 3: a polish (an agent's or the hub's own) after Whisper's reading.
  const polished = !!line.edited && line.edited.by !== MERGE_BY && line.text !== r.text;
  return {
    heard: r.heard,
    whisper: { text: r.text, engine: r.engine },
    ...(polished ? { polished: line.text } : {}),
  };
}

/** The mic session's recheck (mic-session.ts, `__lkMic.recheck`, v16). */
export type RecheckCall = (
  msg: Record<string, unknown>,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

/**
 * The page's passage end with level 2 in front (DebugChat): for a merged line it
 * asks the Mac to re-read the run, then sends the passage end with the reading, or
 * with none when the Mac fails, is slow or the line moved on. A run already being
 * re-read is not asked twice; a part that joined meanwhile sends nothing, since
 * the next passage end re-reads the longer run. Returns the wait, for the tests.
 */
export function createPassageRecheck(d: {
  conf: () => RecheckConf | undefined;
  recheck: () => RecheckCall | undefined;
  /** The page's copy of a line now. */
  line: (id: string) => ChatMessage | undefined;
  send: (recheck?: RecheckAmend) => void;
  now?: () => number;
}) {
  let busy: string | null = null;
  return (line: ChatMessage): Promise<void> | undefined => {
    const conf = d.conf();
    const call = d.recheck();
    const plan = conf && call ? recheckPlan(line, (d.now ?? Date.now)(), conf) : undefined;
    if (!plan || "skip" in plan) return void d.send();
    const key = `${plan.run}:${plan.parts}`;
    if (busy === key) return undefined;
    busy = key;
    return call!(plan.msg, conf!.timeoutMs)
      .catch(() => undefined)
      .then((res) => {
        if (busy === key) busy = null;
        const now = d.line(plan.run);
        if (now?.parts && now.parts.length !== plan.parts) return;
        d.send(recheckAmend(plan, res, now));
      });
  };
}
