/**
 * Acoustic dual-audio & latency delta detector (pure DSP, no DOM required).
 *
 * Detects when another speaker in the room is playing the same TTS audio and
 * measures the real acoustic latency delta (`deltaMs`, e.g. -800ms to +800ms,
 * covering network + OS + Bluetooth/speaker hardware latency).
 *
 * Pipeline:
 * 1. Extract mono PCM from `AudioBufferLike` or `Float32Array`.
 * 2. Compute RMS energy envelopes at `frameMs` (default 10ms = 100 Hz).
 * 3. Compute zero-mean normalized cross-correlation (ZNCC) across lags
 *    `[-maxLagMs, +maxLagMs]`.
 * 4. Refine peak lag with 3-point parabolic sub-frame interpolation for
 *    millisecond-level precision.
 * 5. Apply energy + correlation confidence gates (`minEnergy`, `minCorrelation`)
 *    and an EMA + hysteresis filter (`smoothOffsetUpdate`) so background noise
 *    never triggers false offset adjustments.
 */

/** Default envelope frame duration in milliseconds (10ms RMS window). */
export const DEFAULT_FRAME_MS = 10;
/** Default envelope hop duration in milliseconds (5ms step = 200 Hz). */
export const DEFAULT_HOP_MS = 5;
/** Default maximum lag search radius in milliseconds ([-800ms, +800ms]). */
export const DEFAULT_MAX_LAG_MS = 800;
/** Default minimum normalized cross-correlation required to accept a match. */
export const DEFAULT_MIN_CORRELATION = 0.55;
/** Default minimum RMS energy required on both reference and mic envelopes. */
export const DEFAULT_MIN_ENERGY = 0.005;
/** Default minimum overlapping frames required for a valid correlation estimate. */
export const DEFAULT_MIN_OVERLAP_FRAMES = 20;
/** Default sample rate when raw Float32Array is passed without explicit rate. */
export const DEFAULT_SAMPLE_RATE = 16_000;

const VARIANCE_EPS = 1e-12;

/** Structural subset of Web Audio's `AudioBuffer` so no DOM lib is required. */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels?: number;
  getChannelData(channel: number): Float32Array;
}

export type PcmInput = Float32Array | AudioBufferLike;

export type AcousticDeltaOptions = {
  /** Window size in ms for the RMS energy envelope (default 10ms). */
  frameMs?: number;
  /** Hop step in ms between consecutive envelope frames (default 5ms = 200 Hz). */
  hopMs?: number;
  /** Maximum lag radius in ms, searched over [-maxLagMs, +maxLagMs] (default 800). */
  maxLagMs?: number;
  /** Minimum ZNCC score in [0, 1] required to mark `detected: true` (default 0.55). */
  minCorrelation?: number;
  /** Minimum RMS energy required on both reference and mic envelopes (default 0.005). */
  minEnergy?: number;
  /** Minimum overlapping envelope frames required at a candidate lag (default 20). */
  minOverlapFrames?: number;
  /** Sample rate for `reference` when passed as a raw `Float32Array` (default `sampleRate` or 16000). */
  referenceSampleRate?: number;
  /** Sample rate for `mic` when passed as a raw `Float32Array` (default `sampleRate` or 16000). */
  micSampleRate?: number;
  /** Shared fallback sample rate when raw `Float32Array` inputs are passed (default 16000). */
  sampleRate?: number;
};

export type AcousticGateReason =
  | "low-ref-energy"
  | "low-mic-energy"
  | "insufficient-overlap"
  | "low-correlation";

export type AcousticDeltaResult = {
  /** Whether both energy and correlation confidence gates passed. */
  detected: boolean;
  /**
   * Estimated acoustic latency delta in milliseconds (mic relative to reference),
   * in `[-maxLagMs, +maxLagMs]`. Positive means the room speaker lags behind the
   * local reference (e.g. +350ms); negative means it leads (e.g. -180ms).
   */
  deltaMs: number;
  /** Peak zero-mean normalized cross-correlation in [-1, 1] (0 when gated pre-correlation). */
  correlation: number;
  /** RMS energy of the reference envelope. */
  refEnergy: number;
  /** RMS energy of the mic envelope. */
  micEnergy: number;
  /** Best integer lag in frames before sub-frame interpolation. */
  lagFrames: number;
  /** Rejection reason when `detected` is false, otherwise `null`. */
  reason: AcousticGateReason | null;
};

export type OffsetFilterState = {
  /** Current smoothed acoustic offset in ms (`null` before the first accepted lock). */
  offsetMs: number | null;
  /** Consecutive accepted or consistent-jump detections. */
  consecutiveHits: number;
  /** Most recent accepted/candidate raw `deltaMs`. */
  lastRawDeltaMs: number | null;
};

export type SmoothOffsetOptions = {
  /** EMA smoothing factor in (0, 1] (default 0.25). */
  alpha?: number;
  /** Hysteresis deadband in ms: deltas within this band of `offsetMs` are ignored (default 5). */
  hysteresisMs?: number;
  /** Minimum correlation required to update the filter (default 0.55). */
  minCorrelation?: number;
  /** Jump threshold in ms above which `confirmCount` consecutive hits are required (default 150). */
  maxJumpMs?: number;
  /** Consecutive consistent detections required to accept a jump > `maxJumpMs` (default 2). */
  confirmCount?: number;
};

export type SmoothOffsetResult = {
  /** Next immutable filter state. */
  state: OffsetFilterState;
  /** Current smoothed offset in ms (unchanged if rejected or inside deadband). */
  offsetMs: number | null;
  /** Whether `offsetMs` was updated on this call. */
  updated: boolean;
};

function isAudioBufferLike(input: PcmInput): input is AudioBufferLike {
  return !(input instanceof Float32Array) && typeof input.getChannelData === "function";
}

/**
 * Extracts mono PCM samples and sample rate from a `Float32Array` or `AudioBufferLike`.
 * Multi-channel `AudioBufferLike` inputs are averaged down to mono.
 */
export function extractMonoPcm(
  input: PcmInput,
  fallbackSampleRate = DEFAULT_SAMPLE_RATE,
): { samples: Float32Array; sampleRate: number } {
  if (!isAudioBufferLike(input)) {
    return { samples: input, sampleRate: fallbackSampleRate };
  }
  const chCount = Math.max(1, input.numberOfChannels ?? 1);
  const ch0 = input.getChannelData(0);
  if (chCount === 1) {
    return { samples: ch0, sampleRate: input.sampleRate };
  }
  const mono = new Float32Array(ch0.length);
  for (let c = 0; c < chCount; c++) {
    const ch = input.getChannelData(c);
    const len = Math.min(mono.length, ch.length);
    for (let i = 0; i < len; i++) {
      mono[i] += ch[i];
    }
  }
  const inv = 1 / chCount;
  for (let i = 0; i < mono.length; i++) {
    mono[i] *= inv;
  }
  return { samples: mono, sampleRate: input.sampleRate };
}

/**
 * Computes the RMS energy envelope of a mono PCM buffer with window `frameMs` and
 * step `hopMs` (defaults to `frameMs`, i.e. non-overlapping frames).
 * Non-finite samples are treated as 0 so corrupted frames cannot poison the envelope.
 */
export function computeRmsEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameMs = DEFAULT_FRAME_MS,
  hopMs = frameMs,
): Float32Array {
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(frameMs) ||
    frameMs <= 0 ||
    !Number.isFinite(hopMs) ||
    hopMs <= 0
  ) {
    return new Float32Array(0);
  }
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const samplesPerHop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  if (samples.length < samplesPerFrame) return new Float32Array(0);
  const numFrames = Math.floor((samples.length - samplesPerFrame) / samplesPerHop) + 1;
  if (numFrames <= 0) return new Float32Array(0);

  const env = new Float32Array(numFrames);
  // Hann-weighted RMS suppresses pitch-rate (160–600 Hz) aliasing ripples when
  // downsampling the energy envelope to 100–200 Hz, while preserving exact RMS
  // for stationary signals.
  let weights: Float64Array | null = null;
  if (samplesPerFrame >= 4) {
    weights = new Float64Array(samplesPerFrame);
    let wSum = 0;
    const denom = samplesPerFrame - 1;
    for (let i = 0; i < samplesPerFrame; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
      weights[i] = w;
      wSum += w;
    }
    const invW = 1 / wSum;
    for (let i = 0; i < samplesPerFrame; i++) weights[i] *= invW;
  }

  for (let f = 0; f < numFrames; f++) {
    const start = f * samplesPerHop;
    let sumSq = 0;
    if (weights) {
      for (let i = 0; i < samplesPerFrame; i++) {
        const s = samples[start + i];
        if (Number.isFinite(s)) sumSq += weights[i] * s * s;
      }
      env[f] = Math.sqrt(sumSq);
    } else {
      for (let i = 0; i < samplesPerFrame; i++) {
        const s = samples[start + i];
        if (Number.isFinite(s)) sumSq += s * s;
      }
      env[f] = Math.sqrt(sumSq / samplesPerFrame);
    }
  }
  return env;
}

/** Computes the overall RMS of an energy envelope. */
export function envelopeRms(env: Float32Array): number {
  if (env.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < env.length; i++) {
    const v = env[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / env.length);
}

/**
 * 3-point parabolic sub-frame peak interpolation.
 * Returns fractional frame offset in `[-0.5, +0.5]` relative to the center sample `y0`.
 */
export function parabolicPeak(ym: number, y0: number, yp: number): number {
  const denom = 2 * (ym - 2 * y0 + yp);
  if (!Number.isFinite(denom) || Math.abs(denom) <= VARIANCE_EPS) return 0;
  const shift = (ym - yp) / denom;
  if (!Number.isFinite(shift)) return 0;
  return Math.max(-0.5, Math.min(0.5, shift));
}

/**
 * Computes zero-mean normalized cross-correlation (ZNCC) between two RMS envelopes
 * across integer frame lags `[-maxLagFrames, +maxLagFrames]`, returning the best lag
 * with parabolic sub-frame refinement.
 */
export function correlateEnvelopes(
  refEnv: Float32Array,
  micEnv: Float32Array,
  options: {
    frameMs?: number;
    maxLagMs?: number;
    minOverlapFrames?: number;
  } = {},
): {
  deltaMs: number;
  correlation: number;
  lagFrames: number;
  valid: boolean;
} {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  const maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const minOverlap = options.minOverlapFrames ?? DEFAULT_MIN_OVERLAP_FRAMES;

  if (refEnv.length === 0 || micEnv.length === 0 || frameMs <= 0) {
    return { deltaMs: 0, correlation: 0, lagFrames: 0, valid: false };
  }

  const maxLagFrames = Math.max(0, Math.round(maxLagMs / frameMs));
  const scores = new Float64Array(2 * maxLagFrames + 1);
  const validMask = new Uint8Array(2 * maxLagFrames + 1);

  let bestIdx = -1;
  let bestScore = -Infinity;

  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag++) {
    // mic[n + lag] aligns with ref[n].
    const start = Math.max(0, -lag);
    const end = Math.min(refEnv.length, micEnv.length - lag);
    const count = end - start;
    const idx = lag + maxLagFrames;

    if (count < minOverlap) {
      scores[idx] = -1;
      continue;
    }

    let sumA = 0;
    let sumB = 0;
    for (let n = start; n < end; n++) {
      sumA += refEnv[n];
      sumB += micEnv[n + lag];
    }
    const meanA = sumA / count;
    const meanB = sumB / count;

    let num = 0;
    let varA = 0;
    let varB = 0;
    for (let n = start; n < end; n++) {
      const da = refEnv[n] - meanA;
      const db = micEnv[n + lag] - meanB;
      num += da * db;
      varA += da * da;
      varB += db * db;
    }

    const denom = Math.sqrt(varA * varB);
    const ncc = denom > VARIANCE_EPS ? num / denom : 0;
    scores[idx] = ncc;
    validMask[idx] = 1;

    if (ncc > bestScore) {
      bestScore = ncc;
      bestIdx = idx;
    }
  }

  if (bestIdx < 0 || !Number.isFinite(bestScore)) {
    return { deltaMs: 0, correlation: 0, lagFrames: 0, valid: false };
  }

  const bestLagFrames = bestIdx - maxLagFrames;
  let subFrame = 0;
  if (
    bestIdx > 0 &&
    bestIdx < scores.length - 1 &&
    validMask[bestIdx - 1] === 1 &&
    validMask[bestIdx + 1] === 1
  ) {
    subFrame = parabolicPeak(scores[bestIdx - 1], scores[bestIdx], scores[bestIdx + 1]);
  }

  const rawDeltaMs = (bestLagFrames + subFrame) * frameMs;
  const clampedDeltaMs = Math.max(-maxLagMs, Math.min(maxLagMs, rawDeltaMs));

  return {
    deltaMs: Math.round(clampedDeltaMs * 1000) / 1000,
    correlation: Math.max(-1, Math.min(1, bestScore)),
    lagFrames: bestLagFrames,
    valid: true,
  };
}

/**
 * Estimates the acoustic latency delta (`deltaMs`) between a reference TTS buffer
 * and a microphone capture window, gated by minimum RMS energy and minimum ZNCC.
 */
export function estimateAcousticDelta(
  reference: PcmInput,
  mic: PcmInput,
  options: AcousticDeltaOptions = {},
): AcousticDeltaResult {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  const hopMs = options.hopMs ?? Math.min(DEFAULT_HOP_MS, frameMs);
  const maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const minCorrelation = options.minCorrelation ?? DEFAULT_MIN_CORRELATION;
  const minEnergy = options.minEnergy ?? DEFAULT_MIN_ENERGY;
  const minOverlapFrames =
    options.minOverlapFrames ?? Math.max(DEFAULT_MIN_OVERLAP_FRAMES, Math.round(200 / hopMs));

  const fallbackRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const refPcm = extractMonoPcm(reference, options.referenceSampleRate ?? fallbackRate);
  const micPcm = extractMonoPcm(mic, options.micSampleRate ?? fallbackRate);

  const refEnv = computeRmsEnvelope(refPcm.samples, refPcm.sampleRate, frameMs, hopMs);
  const micEnv = computeRmsEnvelope(micPcm.samples, micPcm.sampleRate, frameMs, hopMs);

  const refEnergy = envelopeRms(refEnv);
  const micEnergy = envelopeRms(micEnv);

  if (refEnv.length < minOverlapFrames || micEnv.length < minOverlapFrames) {
    return {
      detected: false,
      deltaMs: 0,
      correlation: 0,
      refEnergy,
      micEnergy,
      lagFrames: 0,
      reason: "insufficient-overlap",
    };
  }

  if (refEnergy < minEnergy) {
    return {
      detected: false,
      deltaMs: 0,
      correlation: 0,
      refEnergy,
      micEnergy,
      lagFrames: 0,
      reason: "low-ref-energy",
    };
  }

  if (micEnergy < minEnergy) {
    return {
      detected: false,
      deltaMs: 0,
      correlation: 0,
      refEnergy,
      micEnergy,
      lagFrames: 0,
      reason: "low-mic-energy",
    };
  }

  const corr = correlateEnvelopes(refEnv, micEnv, {
    frameMs: hopMs,
    maxLagMs,
    minOverlapFrames,
  });

  if (!corr.valid) {
    return {
      detected: false,
      deltaMs: 0,
      correlation: 0,
      refEnergy,
      micEnergy,
      lagFrames: 0,
      reason: "insufficient-overlap",
    };
  }

  if (corr.correlation < minCorrelation) {
    return {
      detected: false,
      deltaMs: corr.deltaMs,
      correlation: corr.correlation,
      refEnergy,
      micEnergy,
      lagFrames: corr.lagFrames,
      reason: "low-correlation",
    };
  }

  return {
    detected: true,
    deltaMs: corr.deltaMs,
    correlation: corr.correlation,
    refEnergy,
    micEnergy,
    lagFrames: corr.lagFrames,
    reason: null,
  };
}

/** Creates an initial unlocked offset filter state. */
export function createOffsetFilterState(): OffsetFilterState {
  return {
    offsetMs: null,
    consecutiveHits: 0,
    lastRawDeltaMs: null,
  };
}

/**
 * EMA + hysteresis filter for acoustic offset updates.
 *
 * - Rejects measurements that failed the confidence gate (`!detected` or
 *   `correlation < minCorrelation`), leaving `offsetMs` untouched so background
 *   noise never causes false adjustments.
 * - Ignores micro-jitter within `hysteresisMs` once locked.
 * - Requires `confirmCount` consistent detections before accepting a sudden jump
 *   larger than `maxJumpMs`.
 */
export function smoothOffsetUpdate(
  state: OffsetFilterState,
  measurement: Pick<AcousticDeltaResult, "detected" | "deltaMs" | "correlation">,
  options: SmoothOffsetOptions = {},
): SmoothOffsetResult {
  const alpha = Math.max(0.01, Math.min(1, options.alpha ?? 0.25));
  const hysteresisMs = Math.max(0, options.hysteresisMs ?? 5);
  const minCorrelation = options.minCorrelation ?? DEFAULT_MIN_CORRELATION;
  const maxJumpMs = Math.max(0, options.maxJumpMs ?? 150);
  const confirmCount = Math.max(1, Math.round(options.confirmCount ?? 2));

  if (
    !measurement.detected ||
    measurement.correlation < minCorrelation ||
    !Number.isFinite(measurement.deltaMs)
  ) {
    return {
      state: {
        offsetMs: state.offsetMs,
        consecutiveHits: 0,
        lastRawDeltaMs: state.lastRawDeltaMs,
      },
      offsetMs: state.offsetMs,
      updated: false,
    };
  }

  if (state.offsetMs === null) {
    const nextState: OffsetFilterState = {
      offsetMs: measurement.deltaMs,
      consecutiveHits: 1,
      lastRawDeltaMs: measurement.deltaMs,
    };
    return { state: nextState, offsetMs: nextState.offsetMs, updated: true };
  }

  const diff = measurement.deltaMs - state.offsetMs;
  if (Math.abs(diff) < hysteresisMs) {
    return {
      state: {
        offsetMs: state.offsetMs,
        consecutiveHits: state.consecutiveHits + 1,
        lastRawDeltaMs: measurement.deltaMs,
      },
      offsetMs: state.offsetMs,
      updated: false,
    };
  }

  if (Math.abs(diff) > maxJumpMs && confirmCount > 1) {
    const consistentWithLast =
      state.lastRawDeltaMs !== null && Math.abs(measurement.deltaMs - state.lastRawDeltaMs) <= maxJumpMs;
    const hits = consistentWithLast ? state.consecutiveHits + 1 : 1;
    if (hits < confirmCount) {
      return {
        state: {
          offsetMs: state.offsetMs,
          consecutiveHits: hits,
          lastRawDeltaMs: measurement.deltaMs,
        },
        offsetMs: state.offsetMs,
        updated: false,
      };
    }
    const nextOffset = state.offsetMs + alpha * diff;
    const nextState: OffsetFilterState = {
      offsetMs: nextOffset,
      consecutiveHits: hits,
      lastRawDeltaMs: measurement.deltaMs,
    };
    return { state: nextState, offsetMs: nextOffset, updated: true };
  }

  const nextOffset = state.offsetMs + alpha * diff;
  const nextState: OffsetFilterState = {
    offsetMs: nextOffset,
    consecutiveHits: state.consecutiveHits + 1,
    lastRawDeltaMs: measurement.deltaMs,
  };
  return { state: nextState, offsetMs: nextOffset, updated: true };
}
