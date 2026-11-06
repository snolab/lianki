/**
 * The voice cues (owner, 2026-11-05 23:40–23:41 JST): short tones synthesized
 * with Web Audio, no files and no TTS.
 *
 * - "send": a spoken line went out (DebugChat submit, `source: "stt"`), once
 *   per message, whichever path sent it. Mixed over a reply being read.
 * - "start": rising, soft. The VAD confirmed speech (a false start that is
 *   discarded plays nothing). At most one per utterance, debounced.
 * - "end": falling, as soft. The VAD ended an utterance that was kept.
 *
 * The mic is open when any of them plays, so nothing here holds or pauses it:
 * a hold drops the speech under way (mic.ts `hold`) and would cost the first
 * words. Instead `guard()` is true for the cue's playback, its output latency
 * and CUE_TAIL_MS, and createMic does not count the frames heard meanwhile as
 * speech: a VAD start inside the window stays unconfirmed until real speech is
 * heard after it, and an utterance with none is dropped. The audio itself is
 * kept the whole time. Details: docs/voice-mode.md, "Cues".
 *
 * No audio owner claim either (audio-claim.ts): a claim pauses what is
 * playing, and a cue must not interrupt read-aloud. The cue goes straight to
 * the context's destination, so the reply's ducking does not touch it.
 *
 * Everything browser-shaped is injected: unit/voice-cues.test.ts.
 */

export type CueKind = "send" | "start" | "end";

/** The send cue: two sine notes, this loud at their peak, this long in all. */
export const TICK_GAIN = 0.16;
export const TICK_MS = 110;
/** Start and end play during continuous listening, so they stay far under the send cue. */
export const SPEECH_CUE_GAIN = 0.05;
/** Each cue's peak and its notes, in order, as [Hz, ms]. */
export const CUES: Record<CueKind, { gain: number; notes: [number, number][] }> = {
  send: {
    gain: TICK_GAIN,
    notes: [
      [880, 50],
      [1320, TICK_MS - 50],
    ],
  },
  start: {
    gain: SPEECH_CUE_GAIN,
    notes: [
      [523.25, 45],
      [783.99, 45],
    ],
  },
  end: {
    gain: SPEECH_CUE_GAIN,
    notes: [
      [783.99, 45],
      [523.25, 45],
    ],
  },
};
/** Each note's attack, and the level its decay ends at. */
const ATTACK_S = 0.005;
const FLOOR = 0.0001;

/** The slice of an AudioContext the cues use (a fake in the tests). */
export type TickContext = {
  currentTime: number;
  destination: unknown;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(v: number, t: number): unknown };
    connect(n: unknown): unknown;
    start(t: number): void;
    stop(t: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(v: number, t: number): unknown;
      linearRampToValueAtTime(v: number, t: number): unknown;
      exponentialRampToValueAtTime(v: number, t: number): unknown;
    };
    connect(n: unknown): unknown;
  };
};

/**
 * One cue, from `at`: its notes one after the other, each a sine through its
 * own gain (a 5 ms attack, then an exponential decay over the note). One
 * envelope over the whole cue would leave the second note about 20 dB down,
 * which made the first version of the send tick easy to miss. Returns its end.
 * Web Audio only, no `<audio>` element, so iOS keeps it silent on mute.
 */
export function scheduleCue(ctx: TickContext, kind: CueKind, at = ctx.currentTime) {
  const { gain, notes } = CUES[kind];
  let t = at;
  for (const [hz, ms] of notes) {
    const end = t + ms / 1000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.linearRampToValueAtTime(gain, t + ATTACK_S);
    g.gain.exponentialRampToValueAtTime(FLOOR, end);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(hz, t);
    o.connect(g);
    o.start(t);
    o.stop(end);
    t = end;
  }
  return t;
}

/** The send cue (the voice-send sound). */
export const scheduleTick = (ctx: TickContext, at = ctx.currentTime) =>
  scheduleCue(ctx, "send", at);

/** localStorage, synced with the account (chat-voice.cueSend, docs/prefs-sync.md): "0" = off. */
export const CUE_SEND_KEY = "lk:voice-cue-send";
/** localStorage, synced (chat-voice.cueSpeech): the start and end cues; "0" = off. */
export const CUE_SPEECH_KEY = "lk:voice-cue-speech";

/** A cue's switch: on unless turned off. */
export const cueOn = (key: string): boolean => {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
};
export const setCue = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {}
};

/** What decides whether a cue plays now. */
export type CueGate = {
  /** The cue's own switch. */
  on: boolean;
  /** The chat's speaker toggle ("Replies silent" silences every cue: his mute wins). */
  muted: boolean;
  /** The page may not make a sound now (speak-rules.ts: a phone's hidden page). */
  silenced: boolean;
  /** Li is reading a reply: speech heard now may be her own echo. */
  speaking: boolean;
  /** Echo cancellation is on (lk:voice-aec): the mic does not record what the page plays. */
  aec: boolean;
};

/**
 * Whether `kind` plays. Start and end stay out of a reply being read (a leak
 * of it would chime); the send cue is mixed over it. Start plays over his own
 * first words, so only with the echo canceller to keep it out of the recording.
 */
export function cueAllowed(kind: CueKind, g: CueGate): boolean {
  if (!g.on || g.muted || g.silenced) return false;
  if (kind === "send") return true;
  if (g.speaking) return false;
  return kind === "end" || g.aec;
}

/** After a cue the guard stays on this long more (the room's echo, the VAD's frames). */
export const CUE_TAIL_MS = 150;
/** A context that has not resumed by now (no tap yet) drops the cue: it would play late. */
export const CUE_RESUME_MS = 250;
/** A start cue this soon after the last start or end plays nothing: one chime per stretch of talk. */
export const CUE_START_GAP_MS = 1_500;

export type CueContext = TickContext & {
  state?: string;
  resume?(): Promise<void>;
  outputLatency?: number;
  baseLatency?: number;
};

export function createCues(d: {
  ctx: () => CueContext | null;
  allowed: (kind: CueKind) => boolean;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** The last cue's guard ended: the mic's AudioContext may be suspended again. */
  idle?: () => void;
}) {
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  /** Until when frames are not counted as speech. */
  let guardUntil = 0;
  /** Where the next cue may start, on the context's clock: cues never overlap. */
  let nextAt = 0;
  let lastSpeechCue = Number.NEGATIVE_INFINITY;
  let capturing = false;
  /** Send cues for lines that went out during a capture. */
  let deferred = 0;
  let idleTimer: unknown = null;
  const extend = (ms: number) => {
    guardUntil = Math.max(guardUntil, now() + ms);
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      d.idle?.();
    }, guardUntil - now());
  };
  const play = (kind: CueKind): boolean => {
    if (!d.allowed(kind)) return false;
    const c = d.ctx();
    if (!c || c.state === "closed") return false;
    // Guarded from now: the resume takes a moment and the cue follows it.
    extend(CUE_RESUME_MS);
    let done = false;
    let giveUp: unknown = null;
    const go = () => {
      if (done) return;
      done = true;
      clearTimer(giveUp);
      if (c.state !== undefined && c.state !== "running") return;
      const end = scheduleCue(c, kind, Math.max(c.currentTime, nextAt));
      nextAt = end;
      const latency = c.outputLatency ?? c.baseLatency ?? 0;
      extend((end - c.currentTime + latency) * 1000 + CUE_TAIL_MS);
    };
    // Never scheduled on a context still suspended: it would sound at his next tap, late.
    giveUp = setTimer(() => {
      done = true;
    }, CUE_RESUME_MS);
    // Always through resume: a suspend still under way (the mic going off) must not freeze the cue.
    if (c.resume)
      void c.resume().then(go, () => {
        done = true;
      });
    else go();
    return true;
  };
  return {
    /** A spoken line went out. Over a capture it waits for the capture's end, so it is not recorded. */
    send(): boolean {
      if (!capturing) return play("send");
      deferred++;
      return true;
    },
    /** The VAD confirmed speech (mic.ts). */
    speechStart(): boolean {
      const t = now();
      if (t - lastSpeechCue < CUE_START_GAP_MS) return false;
      const played = play("start");
      if (played) lastSpeechCue = t;
      return played;
    },
    /** The VAD ended an utterance that was kept (mic.ts). */
    speechEnd(): boolean {
      const played = play("end");
      if (played) lastSpeechCue = now();
      return played;
    },
    /** The mic went into or out of capture. */
    capture(on: boolean) {
      capturing = on;
      if (on) return;
      for (; deferred > 0; deferred--) play("send");
    },
    /** A cue is playing or just ended: what the mic hears now is not his. */
    guard: () => now() < guardUntil,
    /** No cue is playing (the context may be suspended). */
    quiet: () => now() >= guardUntil,
  };
}

export type Cues = ReturnType<typeof createCues>;
