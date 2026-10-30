/**
 * Whisper mode, automatic: the mic follows the room and how loud the owner
 * speaks, with no toggle (owner, 2026-10-31 04:11 JST). The policy is the
 * one validated offline in #357 (scripts/local-stt/whisper-adaptive.py,
 * POLICY / NORMAL / WHISPER): normal voice CER 0.070 → 0.070 (whisper mode
 * on under 1% of its frames), synthetic whispers 0.604 → 0.270, false
 * triggers unchanged, and a noisy room never enters it.
 *
 * Per 32 ms frame, on the raw signal (before our gain), with Silero's
 * probability p of the previous (processed) frame:
 * - floor: an EMA (FLOOR_ALPHA) of the frame's RMS dB over frames with p < 0.1;
 * - level: a running 90th percentile of RMS dB over frames with p ≥ 0.5
 *   (level += 3 × (0.9 − [rms < level]): up 2.7 dB a frame, down 0.3);
 * - enter whisper: level < ENTER_LEVEL, floor < QUIET_FLOOR and level − floor
 *   ≥ MIN_SNR; leave: level > EXIT_LEVEL or floor > NOISY_FLOOR (the gaps
 *   are the hysteresis);
 * - gain: 0 dB in normal; in whisper clamp(TARGET − level, 0, MAX_GAIN),
 *   rising at most SLEW_DB a frame and falling at most RELEASE_DB; a tanh
 *   soft limiter at 0.9 FS follows it (MicButton.tsx).
 *
 * The VAD's start threshold and minSpeechMs change only between utterances
 * (taken at the onset); the endpoint follows the current state. While the
 * agent's voice is out nothing is learned (with echo cancellation off, the
 * room is the TTS), and the gain never rises. Every number is tunable on the
 * page: `globalThis.__lkVoiceAdapt = { ENTER_LEVEL: -32 }` (read each frame).
 */

export type AdaptParams = {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  endpointMs: number;
  endpointMin: number;
  endpointMargin: number;
};
export const NORMAL: AdaptParams = {
  positiveSpeechThreshold: 0.3,
  negativeSpeechThreshold: 0.25,
  minSpeechMs: 250,
  endpointMs: 600,
  endpointMin: 0.35,
  endpointMargin: 0.25,
};
export const WHISPER: AdaptParams = {
  positiveSpeechThreshold: 0.2,
  negativeSpeechThreshold: 0.15,
  minSpeechMs: 150,
  endpointMs: 800,
  endpointMin: 0.15,
  endpointMargin: 0.1,
};
export const POLICY = {
  ENTER_LEVEL: -34,
  EXIT_LEVEL: -30,
  QUIET_FLOOR: -50,
  NOISY_FLOOR: -45,
  MIN_SNR: 8,
  FLOOR_ALPHA: 0.02,
  FLOOR_P: 0.1,
  LEVEL_P: 0.5,
  LEVEL_Q: 0.9,
  LEVEL_STEP: 3,
  SLEW_DB: 0.5,
  RELEASE_DB: 6,
  TARGET: -20,
  MAX_GAIN: 30,
};
export type Policy = typeof POLICY;
export const FLOOR_START = -60;
export const LEVEL_START = -20;
/** The soft limiter's ceiling (FS). */
export const LIMIT = 0.9;

/** The policy with the page's overrides (finite numbers only). */
export function adaptPolicy(
  over: unknown = (globalThis as { __lkVoiceAdapt?: unknown }).__lkVoiceAdapt,
): Policy {
  const p = { ...POLICY };
  if (over && typeof over === "object")
    for (const k of Object.keys(p) as (keyof Policy)[]) {
      const v = (over as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
    }
  return p;
}

/** A frame's RMS in dB (mean square, as the eval's db()). */
export function frameDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return 10 * Math.log10((frame.length ? sum / frame.length : 0) + 1e-12);
}

/** The tanh soft limiter as a WaveShaper curve: y = 0.9 · tanh(x / 0.9). */
export function limiterCurve(n = 1024, ceiling = LIMIT): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ceiling * Math.tanh(x / ceiling);
  }
  return c;
}

/**
 * The device's override (localStorage lk:voice-whisper; the /words Settings
 * sheet's "Whisper mode", never synced): "force" = always whisper, "off" =
 * never, unset = adaptive. Read at each frame, so a change applies live.
 */
export const WHISPER_KEY = "lk:voice-whisper";
export type WhisperMode = "auto" | "force" | "off";
export function whisperMode(): WhisperMode {
  try {
    const v = globalThis.localStorage?.getItem(WHISPER_KEY);
    return v === "force" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

export type AdaptState = AdaptParams & {
  mode: WhisperMode;
  /** Whisper settings in force (forced, or the policy chose them). */
  whisper: boolean;
  /** The room and his recent speech, raw dBFS; the gain in force, dB. */
  floorDb: number;
  levelDb: number;
  gainDb: number;
};

/**
 * The estimator. `frame` takes each frame as the VAD heard it (after our
 * gain, undone here), its probability, and whether an utterance is being
 * captured; it returns the gain to apply now (dB). `state()` is the current
 * one (the endpoint reads it); `vad()` the start settings, which change only
 * between utterances. `subscribe` hears a change of mode or of the VAD
 * settings, and of the gain by a dB or more (the menu's readout).
 */
export function createAdaptive(
  opts: { speaking?: () => boolean; policy?: () => Policy; mode?: () => WhisperMode } = {},
) {
  const modeOf = opts.mode ?? whisperMode;
  let mode: WhisperMode = "auto";
  /** The policy's own verdict (kept learning under an override). */
  let auto = false;
  const policy = opts.policy ?? (() => adaptPolicy());
  const listeners = new Set<(s: AdaptState) => void>();
  let floor = FLOOR_START;
  let level = LEVEL_START;
  let whisper = false;
  let gain = 0;
  let lastP = 0;
  /** The mode the VAD's start settings follow (latched between utterances). */
  let vadWhisper = false;
  let shownGain = 0;
  /** The latest frame, for the mic meter (read by its rAF; never emitted). */
  const live = { db: -120, prob: 0, at: 0 };
  const params = (w: boolean) => (w ? WHISPER : NORMAL);
  const state = (): AdaptState => ({
    ...params(whisper),
    mode,
    positiveSpeechThreshold: params(vadWhisper).positiveSpeechThreshold,
    negativeSpeechThreshold: params(vadWhisper).negativeSpeechThreshold,
    minSpeechMs: params(vadWhisper).minSpeechMs,
    whisper,
    floorDb: Math.round(floor * 10) / 10,
    levelDb: Math.round(level * 10) / 10,
    gainDb: Math.round(gain * 10) / 10,
  });
  const emit = () => {
    const s = state();
    for (const f of listeners) f(s);
  };
  return {
    state,
    /** The latest frame as the VAD heard it (dBFS after the gain, p, when): the meter's source. */
    live: () => live,
    /** Silero's start settings (applied with setOptions between utterances). */
    vad: () => {
      const p = params(vadWhisper);
      return {
        positiveSpeechThreshold: p.positiveSpeechThreshold,
        negativeSpeechThreshold: p.negativeSpeechThreshold,
        minSpeechMs: p.minSpeechMs,
      };
    },
    frame(f: Float32Array, prob: number | undefined, capturing: boolean): number {
      const P = policy();
      const speaking = opts.speaking?.() ?? false;
      const r = frameDb(f) - gain;
      let changed = false;
      if (!speaking) {
        if (lastP < P.FLOOR_P) floor += (r - floor) * P.FLOOR_ALPHA;
        if (lastP >= P.LEVEL_P) level += P.LEVEL_STEP * (P.LEVEL_Q - (r < level ? 1 : 0));
        if (!auto && level < P.ENTER_LEVEL && floor < P.QUIET_FLOOR && level - floor >= P.MIN_SNR)
          auto = true;
        else if (auto && (level > P.EXIT_LEVEL || floor > P.NOISY_FLOOR)) auto = false;
      }
      const m = modeOf();
      const was = { whisper, mode };
      mode = m;
      whisper = m === "force" ? true : m === "off" ? false : auto;
      changed = was.whisper !== whisper || was.mode !== mode;
      lastP = prob ?? 0;
      // The meter's reading (MicLevel.tsx): what the VAD heard, this frame.
      live.db = r + gain;
      live.prob = prob ?? 0;
      live.at = Date.now();
      const want = whisper ? Math.min(P.MAX_GAIN, Math.max(0, P.TARGET - level)) : 0;
      // Rise slowly, fall fast; never rise while the agent speaks.
      const step = Math.max(-P.RELEASE_DB, Math.min(speaking ? 0 : P.SLEW_DB, want - gain));
      gain += step;
      if (!capturing && vadWhisper !== whisper) {
        vadWhisper = whisper;
        changed = true;
      }
      if (Math.abs(gain - shownGain) >= 1 || (gain === 0 && shownGain !== 0)) {
        shownGain = gain;
        changed = true;
      }
      if (changed) emit();
      return gain;
    },
    /** Hear a change (the VAD's settings, the readout); returns an unsubscribe. */
    subscribe(f: (s: AdaptState) => void) {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
  };
}
export type Adaptive = ReturnType<typeof createAdaptive>;

/** globalThis key of the page's estimator: one per page, kept across hot swaps. */
export const ADAPT_KEY = "__lkAdapt";
/** Bumped when the estimator's shape changes (an older one is replaced). */
export const ADAPT_V = 2;

/** The page's estimator, made once (`speaking` is read at each frame). */
export function voiceAdapt(speaking?: () => boolean): Adaptive {
  const g = globalThis as unknown as Record<string, (Adaptive & { v?: number }) | undefined>;
  const have = g[ADAPT_KEY];
  if (have?.v === ADAPT_V) return have;
  const a = Object.assign(createAdaptive({ speaking: () => speaking?.() ?? false }), {
    v: ADAPT_V,
  });
  g[ADAPT_KEY] = a;
  return a;
}
