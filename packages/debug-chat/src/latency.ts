/**
 * Per-utterance latency, voice → reply (docs/monitoring.md, "Voice latency").
 * One record per spoken line, from timestamps taken along the way:
 *
 *   mic (mic.ts createMic)       t_lastVoice, t_speechEnd, t_uploadStart, t_sttDone
 *   STT route (MicButton)        sttServerMs
 *   the input (DebugChat)        t_shown, t_sent       → VoiceTiming on the line
 *   the socket (DebugEval)       t_echo (the hub's copy of the line comes back),
 *                                t_ack (a listener's "busy" beat), t_reply
 *   the voice session (voice.ts) t_audible (the reply starts playing)
 *
 * All on the page's own clock (Date.now()), so no stage mixes clocks. The
 * hub's `at` is kept for reference only. A finished record is logged once
 * (`{ev: "voice-latency", …}` through the voice log) and shown in the chat's
 * ⋯ menu. The store lives on globalThis, so the deployed DebugEval and a
 * hot-loaded widget share it. Event-driven: nothing here polls or sets timers.
 */
import type { UiStrings } from "./ui-strings";
import { voice } from "./voice";
import type { ChatMessage, VoiceTiming } from "./wire";

/** One utterance's marks while it is on its way (keyed by the mic's seq). */
export type UttMarks = VoiceTiming & { dropped?: boolean };

/** A voice line after it was sent, until its reply (and its first sound). */
export type LatencyRecord = {
  id: string;
  chars: number;
  timing: VoiceTiming;
  /** The hub's copy of the line reached this page (page→hub→page). */
  t_echo?: number;
  /** The hub's `at` on that copy (the hub's clock; reference only). */
  hubAt?: number;
  /** A listener's busy beat after the send ("heard you"). */
  t_ack?: number;
  /** The agent's reply reached this page. */
  t_reply?: number;
  /** The reply started playing (speechSynthesis start / audio play). */
  t_audible?: number;
  /** The reply is being read: the record waits for t_audible. */
  spoken?: boolean;
};

/** The stages, in ms; a stage whose two ends are not both known is absent. */
export type Breakdown = {
  /** Last voiced frame → the VAD ends the utterance: its silence timeout. */
  vadMs?: number;
  /** VAD end → upload start (WAV encoding). */
  encodeMs?: number;
  /** The STT request's round trip, its server part, and the rest (network, queueing). */
  sttMs?: number;
  sttServerMs?: number;
  sttNetMs?: number;
  /** Transcript back → in the input (waiting on an earlier utterance, the echo guard). */
  waitMs?: number;
  /** In the input → sent (auto-send is at once for a spoken sentence). */
  sendMs?: number;
  /** Sent → the hub's copy back on this page. */
  hubMs?: number;
  /** Sent → a listener's busy beat. */
  ackMs?: number;
  /** Hub copy back → the agent's reply here (listener wake-up + the agent's turn). */
  agentMs?: number;
  /** Reply here → it starts playing. */
  voiceMs?: number;
  /** End of speech (last voiced frame, else the VAD's end) → the reply here. */
  replyMs?: number;
  /** End of speech → the reply audible (or, unspoken, here). */
  totalMs?: number;
};

const diff = (a?: number, b?: number) =>
  a !== undefined && b !== undefined && b >= a ? b - a : undefined;

/** The breakdown of one record (pure). */
export function breakdown(r: Pick<LatencyRecord, "timing"> & Partial<LatencyRecord>): Breakdown {
  const t = r.timing;
  const start = t.t_lastVoice ?? t.t_speechEnd;
  const out: Breakdown = {
    vadMs: diff(t.t_lastVoice, t.t_speechEnd),
    encodeMs: diff(t.t_speechEnd, t.t_uploadStart),
    sttMs: diff(t.t_uploadStart, t.t_sttDone),
    sttServerMs: t.sttServerMs,
    waitMs: diff(t.t_sttDone, t.t_shown),
    sendMs: diff(t.t_shown ?? t.t_sttDone, t.t_sent),
    hubMs: diff(t.t_sent, r.t_echo),
    ackMs: diff(t.t_sent, r.t_ack),
    agentMs: diff(r.t_echo ?? t.t_sent, r.t_reply),
    voiceMs: diff(r.t_reply, r.t_audible),
    replyMs: diff(start, r.t_reply),
    totalMs: diff(start, r.t_audible ?? r.t_reply),
  };
  if (out.sttMs !== undefined && t.sttServerMs !== undefined)
    out.sttNetMs = Math.max(0, out.sttMs - t.sttServerMs);
  for (const k of Object.keys(out) as (keyof Breakdown)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * The timing a voice line carries: the latest-spoken utterance that made it
 * into the input (not dropped, transcribed and shown), with the send time.
 * `used` are the marks it consumes: that one and every one spoken before it.
 */
export function pickTiming(
  marks: ReadonlyMap<number, UttMarks>,
  now: number,
): { timing: VoiceTiming; used: number[] } | undefined {
  let best: [number, UttMarks] | undefined;
  for (const e of marks) {
    const m = e[1];
    if (m.dropped || m.t_sttDone === undefined || m.t_speechEnd === undefined) continue;
    if (!best || m.t_speechEnd > (best[1].t_speechEnd as number)) best = e;
  }
  if (!best) return undefined;
  const end = best[1].t_speechEnd as number;
  const used = [...marks].filter(([, m]) => (m.t_speechEnd ?? 0) <= end).map(([k]) => k);
  const { dropped: _d, ...timing } = best[1];
  return { timing: { ...timing, t_sent: now }, used };
}

/** Seconds with one decimal, for the menu. */
export const secs = (ms: number) => (ms / 1000).toFixed(1);

/** The labels the menu's Latency row uses (ui-strings.ts). */
export type LatencyLabels = Pick<
  UiStrings,
  "latVad" | "latStt" | "latSend" | "latHub" | "latReply" | "latVoice"
>;

/**
 * The menu's Latency row: the total, and each known stage in path order as
 * [label, seconds] (the small steps encode, wait and send counted as one).
 */
export function latencyRows(
  b: Breakdown,
  l: LatencyLabels,
): { total?: string; parts: [string, string][] } {
  const local = [b.encodeMs, b.waitMs, b.sendMs].filter((x) => x !== undefined) as number[];
  const parts: [string, number | undefined][] = [
    [l.latVad, b.vadMs],
    [l.latStt, b.sttMs],
    [l.latSend, local.length ? local.reduce((a, x) => a + x, 0) : undefined],
    [l.latHub, b.hubMs],
    [l.latReply, b.agentMs],
    [l.latVoice, b.voiceMs],
  ];
  return {
    ...(b.totalMs !== undefined ? { total: secs(b.totalMs) } : {}),
    parts: parts.filter((p) => p[1] !== undefined).map(([k, v]) => [k, secs(v as number)]),
  };
}

/** The labels of the two-line latency readout (ui-strings.ts). */
export type LatencyLineLabels = Pick<
  UiStrings,
  | "latSpeechLine"
  | "latReplyLine"
  | "latTotal"
  | "latPause"
  | "latRecog"
  | "latLocal"
  | "latCloud"
  | "latSend"
  | "latHub"
  | "latToAgent"
  | "latAgent"
  | "latVoiceStart"
  | "latOther"
>;
type Group = { total: string; parts: [string, string][] };
/** An "other" part shows the rest once it reaches this (so the parts add up). */
export const OTHER_MIN_MS = 50;

/**
 * The menu's latency, as two lines whose parts each add up to their total:
 * - speech → text (sent): the pause detection, the recognition (local or
 *   cloud), the page's own steps (encode, wait, send);
 * - the reply: to the agent (its listener's busy beat, else the hub's copy
 *   back), the agent's turn, the voice's start;
 * and the overall total. Where the measured parts fall short of a line's
 * span, an "other" part holds the rest. Pure: from one record.
 */
export function latencyLines(
  r: Pick<LatencyRecord, "timing"> & Partial<LatencyRecord>,
  l: LatencyLineLabels,
  via?: "local" | "cloud",
): { total?: string; speech?: Group; reply?: Group } {
  const t = r.timing;
  const start = t.t_lastVoice ?? t.t_speechEnd;
  const end = r.t_audible ?? r.t_reply;
  const group = (span: number | undefined, parts: [string, number | undefined][]) => {
    if (span === undefined) return undefined;
    const known = parts.filter((p): p is [string, number] => p[1] !== undefined);
    const rest = span - known.reduce((a, p) => a + p[1], 0);
    if (rest >= OTHER_MIN_MS) known.push([l.latOther, rest]);
    return { total: secs(span), parts: known.map(([k, v]) => [k, secs(v)] as [string, string]) };
  };
  const own = [diff(t.t_speechEnd, t.t_uploadStart), diff(t.t_sttDone, t.t_shown), diff(t.t_shown ?? t.t_sttDone, t.t_sent)]
    .filter((x) => x !== undefined) as number[];
  const recog = via ? `${l.latRecog} (${via === "local" ? l.latLocal : l.latCloud})` : l.latRecog;
  const speech = group(diff(start, t.t_sent), [
    [l.latPause, diff(t.t_lastVoice, t.t_speechEnd)],
    [recog, diff(t.t_uploadStart, t.t_sttDone)],
    [l.latSend, own.length ? own.reduce((a, x) => a + x, 0) : undefined],
  ]);
  const heardAt = r.t_ack ?? r.t_echo;
  const reply = group(diff(t.t_sent, end), [
    [r.t_ack !== undefined ? l.latToAgent : l.latHub, diff(t.t_sent, heardAt)],
    [l.latAgent, diff(heardAt ?? t.t_sent, r.t_reply)],
    [l.latVoiceStart, diff(r.t_reply, r.t_audible)],
  ]);
  const total = diff(start, end);
  return {
    ...(total !== undefined ? { total: secs(total) } : {}),
    ...(speech ? { speech } : {}),
    ...(reply ? { reply } : {}),
  };
}

/**
 * Which recognizer made each final (MicButton): the owner's Mac (local) or
 * the route (cloud), with when it finished, so the menu can say which one
 * a record's text came from (matched by time: the wire's timing carries
 * numbers only). On globalThis: kept across a hot swap.
 */
export function sttVia(): { at: number; via: "local" | "cloud" }[] {
  const g = globalThis as { __lkSttVia?: { at: number; via: "local" | "cloud" }[] };
  return (g.__lkSttVia ??= []);
}
export function noteSttVia(via: "local" | "cloud", at = Date.now()) {
  const l = sttVia();
  l.push({ at, via });
  if (l.length > 20) l.shift();
}
/** The recognizer of the final that finished nearest `t` (within 2 s). */
export function viaAt(t: number | undefined): "local" | "cloud" | undefined {
  if (t === undefined) return undefined;
  let best: { at: number; via: "local" | "cloud" } | undefined;
  for (const e of sttVia())
    if (Math.abs(e.at - t) <= 2000 && (!best || Math.abs(e.at - t) < Math.abs(best.at - t))) best = e;
  return best?.via;
}

/** Marks older than this are forgotten (an utterance that never made it). */
export const MARK_TTL_MS = 120_000;
/** The finished records kept (latest last), for the menu and the logs. */
export const KEEP_RECORDS = 20;

export type LatencyStore = ReturnType<typeof createLatency>;

export function createLatency(d: {
  now?: () => number;
  log?: (ev: Record<string, unknown>) => void;
} = {}) {
  const now = d.now ?? Date.now;
  const marks = new Map<number, UttMarks>();
  let current: LatencyRecord | null = null;
  const done: (LatencyRecord & { breakdown: Breakdown })[] = [];
  const subs = new Set<() => void>();
  const prune = (t: number) => {
    for (const [k, m] of marks) if (t - (m.t_speechEnd ?? t) > MARK_TTL_MS) marks.delete(k);
  };
  const finish = () => {
    const r = current;
    if (!r) return;
    current = null;
    const b = breakdown(r);
    done.push({ ...r, breakdown: b });
    if (done.length > KEEP_RECORDS) done.shift();
    d.log?.({
      ev: "voice-latency",
      id: r.id,
      chars: r.chars,
      replied: r.t_reply !== undefined,
      ...b,
      timing: r.timing,
      ...(r.hubAt !== undefined ? { hubAt: r.hubAt } : {}),
    });
    for (const f of subs) f();
  };
  return {
    /**
     * The mic's marks for utterance `seq`. One with `t_speechEnd` starts the
     * utterance afresh (a seq may be reused by a new mic session).
     */
    mark(seq: number, patch: UttMarks) {
      const t = now();
      prune(t);
      const prev = patch.t_speechEnd !== undefined ? undefined : marks.get(seq);
      if (!prev && patch.t_speechEnd === undefined) return;
      marks.set(seq, { ...prev, ...patch });
    },
    /** Transcripts landed in the input: every finished, unshown one is stamped. */
    shown() {
      const t = now();
      for (const m of marks.values())
        if (!m.dropped && m.t_sttDone !== undefined && m.t_shown === undefined) m.t_shown = t;
    },
    /** A voice line is about to go out: its timing (undefined if the mic left none). */
    take(): VoiceTiming | undefined {
      const p = pickTiming(marks, now());
      if (!p) return undefined;
      for (const k of p.used) marks.delete(k);
      return p.timing;
    },
    /** The line went out with this id; an earlier record still open is closed as is. */
    sent(id: string, text: string, timing: VoiceTiming) {
      finish();
      current = { id, chars: text.length, timing };
    },
    /**
     * A chat line arrived on the socket. The line's own copy stamps t_echo;
     * the first agent reply to the main thread after it stamps t_reply.
     * `spoken`: the voice session queued it, so the record waits for audible().
     */
    heard(m: Pick<ChatMessage, "id" | "from" | "at" | "to">, spoken = false) {
      const r = current;
      if (!r) return;
      if (m.from !== "agent") {
        if (m.id === r.id && r.t_echo === undefined) {
          r.t_echo = now();
          r.hubAt = m.at;
        }
        return;
      }
      if (m.to && m.to !== "/") return;
      if (r.t_reply !== undefined) return;
      r.t_reply = now();
      r.spoken = spoken;
      if (!spoken) finish();
    },
    /** A listener's busy beat ("heard you"). */
    ack() {
      if (current && current.t_ack === undefined) current.t_ack = now();
    },
    /** A reply started playing. */
    audible() {
      if (!current || current.t_reply === undefined || !current.spoken) return;
      current.t_audible = now();
      finish();
    },
    /** The finished records, oldest first, and the one open. */
    records: () => done.slice(),
    latest: () => done.at(-1),
    open: () => current,
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

const KEY = "__lkLatency";
const V = 1;

/**
 * The page's store, shared by every copy of this module (the deployed
 * DebugEval and a hot-loaded widget): it logs through the voice session's
 * log (devLog) and hears the session's "a reply started playing".
 */
export function voiceLatency(): LatencyStore {
  const g = globalThis as unknown as Record<string, (LatencyStore & { v: number }) | undefined>;
  const have = g[KEY];
  if (have && have.v === V) return have;
  const s = Object.assign(createLatency({ log: (ev) => voice().log(ev) }), { v: V });
  // An older voice session (hot swap) may not have the hook: then t_audible stays unknown.
  voice().onStart?.(() => s.audible());
  g[KEY] = s;
  return s;
}
