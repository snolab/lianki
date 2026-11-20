/**
 * Play reports (docs/echo-suppression.md, layer (b)): each of his pages tells
 * the chat hub what it is reading aloud, as it reads it, so a mic on ANOTHER
 * device that hears it back is matched by time and text (lib/echo-reports.ts)
 * and the line is shown as a read-aloud echo, never as his words.
 *
 * One frame when a sentence starts, one when it ends, from the sound's own
 * events (no timer):
 *
 *   {type:"playing", ref, text, alt?, voice, from, synced?}
 *   {type:"played",  ref, to, synced?}
 *
 * - `text`: the spoken form (what the room hears); `alt` the written one.
 * - `from`/`to`: hub clock, the page clock plus the offset sync-speak keeps
 *   (`__lkHubClock`); `synced` says the offset was known (else the page's own
 *   clock, and the hub uses its receive time).
 * - A private screen (`[data-lk-private-screen]`) sends hashed n-grams
 *   (`g2`, `g3`, echo.ts gramHashes) instead of any text.
 *
 * Sent only with flag voice.echo-reports on (setEchoReports, from the root
 * layout) and a sender attached (DebugEval, on the owner's socket). State on
 * globalThis: the /words bundle and a hot-loaded widget share one reporter.
 */
import { gramHashes } from "./echo";
import { hubClock } from "./sync-speak";

/** Feature flag (lib/flags.ts): pages report what they play; the hub matches by time and text. */
export const ECHO_REPORTS_FLAG = "voice.echo-reports";
/** A report's text is cut to this many characters (one sentence is far shorter). */
export const PLAY_TEXT_MAX = 2000;

export type PlayingFrame = {
  type: "playing";
  ref: string;
  text?: string;
  alt?: string;
  g2?: string[];
  g3?: string[];
  voice: string;
  from: number;
  synced?: true;
};
export type PlayedFrame = { type: "played"; ref: string; to: number; synced?: true };
export type PlayFrame = PlayingFrame | PlayedFrame;

type Reporter = {
  on: boolean;
  send: ((f: PlayFrame) => boolean) | null;
  n: number;
};
const reporter = (): Reporter => {
  const g = globalThis as unknown as { __lkPlayReport?: Reporter };
  return (g.__lkPlayReport ??= { on: false, send: null, n: 0 });
};

/** Flag voice.echo-reports, set by DebugEval from the root layout. */
export function setEchoReports(on: boolean) {
  reporter().on = !!on;
}
export const echoReportsOn = () => reporter().on;

/** The owner's socket (DebugEval), or null when it closes. */
export function setPlaySender(send: ((f: PlayFrame) => boolean) | null) {
  reporter().send = send;
}

/** A private screen is open (/vibe's doc, a private /reader text): no readable text leaves the page. */
const privateScreen = (): boolean => {
  try {
    return !!globalThis.document?.querySelector?.("[data-lk-private-screen]");
  } catch {
    return false;
  }
};

/** A page time on the hub's clock, when the offset is known. */
const onHub = (at: number): { t: number; synced?: true } => {
  const off = hubClock().offset();
  return off === null ? { t: Math.round(at) } : { t: Math.round(at + off), synced: true };
};

const deliver = (f: PlayFrame): boolean => {
  const r = reporter();
  if (!r.on || !r.send) return false;
  try {
    return r.send(f);
  } catch {
    return false;
  }
};

/**
 * A sentence (or a word, a passage) starts playing at page time `at`: the
 * report goes out, and its ref comes back for reportPlayed (null when nothing
 * was sent: the flag off, no socket, no words).
 */
export function reportPlaying(o: {
  text: string;
  alt?: string;
  voice: string;
  at: number;
  /** The chat line it reads (its id): the hub can point the echo at it. */
  line?: string;
}): string | null {
  const r = reporter();
  if (!r.on || !r.send || !o.text.trim()) return null;
  const n = ++r.n;
  const ref = o.line ? `${o.line.slice(0, 64)}#${n}` : `p${n}`;
  const { t, synced } = onHub(o.at);
  const text = o.text.slice(0, PLAY_TEXT_MAX);
  const alt = o.alt && o.alt !== o.text ? o.alt.slice(0, PLAY_TEXT_MAX) : undefined;
  const words = privateScreen()
    ? {
        g2: gramHashes(`${text} ${alt ?? ""}`, 2),
        g3: gramHashes(`${text} ${alt ?? ""}`, 3),
      }
    : { text, ...(alt ? { alt } : {}) };
  const sent = deliver({
    type: "playing",
    ref,
    ...words,
    voice: o.voice.slice(0, 40),
    from: t,
    ...(synced ? { synced } : {}),
  });
  return sent ? ref : null;
}

/** The sound reported as `ref` stopped at page time `at`. */
export function reportPlayed(ref: string, at: number) {
  const { t, synced } = onHub(at);
  deliver({ type: "played", ref, to: t, ...(synced ? { synced } : {}) });
}

/**
 * A voice line's spoken span on the hub's clock (the chat frame's `hubSpan`),
 * from its timing (page clock) and the sync-speak offset; undefined without
 * either. The hub lines it up with the play reports (lib/echo-reports.ts).
 */
export function hubSpanOf(
  timing: { t_speechStart?: number; t_speechEnd?: number; audioMs?: number } | undefined,
  offset: number | null = hubClock().offset(),
): { from: number; to: number } | undefined {
  if (offset === null || timing?.t_speechEnd === undefined) return undefined;
  const end = timing.t_speechEnd;
  const start =
    timing.t_speechStart !== undefined && timing.t_speechStart <= end
      ? timing.t_speechStart
      : end - (timing.audioMs ?? 0);
  return { from: Math.round(start + offset), to: Math.round(end + offset) };
}
