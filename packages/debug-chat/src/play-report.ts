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
/** A sound still playing renews its report this often (under the hub's PLAY_LEASE_MS, 30 s). */
export const PLAY_RENEW_MS = 20_000;
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
  /** The same sound, still playing: the hub moves its lease (lib/echo-reports.ts PLAY_LEASE_MS). */
  renew?: true;
};
export type PlayedFrame = { type: "played"; ref: string; to: number; synced?: true };
export type PlayFrame = PlayingFrame | PlayedFrame;

type Reporter = {
  on: boolean;
  send: ((f: PlayFrame) => boolean) | null;
  n: number;
  /** Sounds reported and not yet ended, by ref: what a renewal resends. */
  open?: Map<string, PlayingFrame>;
};
const reporter = (): Reporter => {
  const g = globalThis as unknown as { __lkPlayReport?: Reporter };
  return (g.__lkPlayReport ??= { on: false, send: null, n: 0 });
};
/** Open sounds kept at most (a lost "played" never grows the map). */
const OPEN_MAX = 32;

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
 * was sent: the flag off, no socket). Empty `text` sends a time-only report.
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
  if (!r.on || !r.send) return null;
  const n = ++r.n;
  const ref = o.line ? `${o.line.slice(0, 64)}#${n}` : `p${n}`;
  const { t, synced } = onHub(o.at);
  const text = o.text.trim() ? o.text.slice(0, PLAY_TEXT_MAX) : "";
  const alt = text && o.alt && o.alt !== o.text ? o.alt.slice(0, PLAY_TEXT_MAX) : undefined;
  // No words (a file, a stream): a time-only report, which still opens the hub's play window.
  const words = !text
    ? {}
    : privateScreen()
    ? {
        g2: gramHashes(`${text} ${alt ?? ""}`, 2),
        g3: gramHashes(`${text} ${alt ?? ""}`, 3),
      }
    : { text, ...(alt ? { alt } : {}) };
  const frame: PlayingFrame = {
    type: "playing",
    ref,
    ...words,
    voice: o.voice.slice(0, 40),
    from: t,
    ...(synced ? { synced } : {}),
  };
  const sent = deliver(frame);
  if (!sent) return null;
  const open = (r.open ??= new Map());
  open.set(ref, frame);
  while (open.size > OPEN_MAX) open.delete(open.keys().next().value as string);
  return ref;
}

/**
 * The sound reported as `ref` is still playing (a long stream): the hub's
 * lease on it moves on (lib/echo-reports.ts PLAY_LEASE_MS), its start does
 * not. False when it is not open here (ended, never sent) or nothing was sent.
 */
export function renewPlaying(ref: string): boolean {
  const f = reporter().open?.get(ref);
  return f ? deliver({ ...f, renew: true }) : false;
}

/** The sound reported as `ref` stopped at page time `at`. */
export function reportPlayed(ref: string, at: number) {
  reporter().open?.delete(ref);
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
