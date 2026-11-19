import { describe, expect, it } from "bun:test";
import {
  type AudioBufferLike,
  computeRmsEnvelope,
  correlateEnvelopes,
  createOffsetFilterState,
  estimateAcousticDelta,
  extractMonoPcm,
  parabolicPeak,
  smoothOffsetUpdate,
} from "@lianki/debug-chat/audio-sync-acoustic";

/** Deterministic PRNG (mulberry32) so tests never flake. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a synthetic speech-like TTS waveform (syllable-rate amplitude-modulated
 * multi-tone + breathy noise bursts) over `durationMs` at `sampleRate`.
 */
function makeSpeechSignal(durationMs: number, sampleRate: number, seed = 42): Float32Array {
  const len = Math.round((durationMs * sampleRate) / 1000);
  const out = new Float32Array(len);
  const rng = makeRng(seed);

  // Irregular syllable bursts so the envelope is non-periodic and has sharp, unique structure.
  const bursts = [
    { startMs: 250, widthMs: 140, amp: 0.7 },
    { startMs: 460, widthMs: 90, amp: 0.45 },
    { startMs: 650, widthMs: 210, amp: 0.85 },
    { startMs: 980, widthMs: 120, amp: 0.6 },
    { startMs: 1220, widthMs: 180, amp: 0.9 },
    { startMs: 1520, widthMs: 100, amp: 0.5 },
    { startMs: 1750, widthMs: 220, amp: 0.8 },
    { startMs: 2100, widthMs: 150, amp: 0.75 },
  ];

  for (let i = 0; i < len; i++) {
    const tMs = (i * 1000) / sampleRate;
    const tSec = tMs / 1000;
    let env = 0;
    for (const b of bursts) {
      const d = (tMs - b.startMs) / b.widthMs;
      if (Math.abs(d) < 2.5) {
        env += b.amp * Math.exp(-0.5 * d * d);
      }
    }
    const carrier =
      0.6 * Math.sin(2 * Math.PI * 190 * tSec) +
      0.3 * Math.sin(2 * Math.PI * 420 * tSec) +
      0.1 * (rng() * 2 - 1);
    out[i] = env * carrier;
  }
  return out;
}

/**
 * Shifts `src` by `shiftMs` (positive = delayed in time, negative = earlier in time),
 * scales by `gain`, and adds deterministic Gaussian-like background noise.
 */
function shiftAndNoise(
  src: Float32Array,
  sampleRate: number,
  shiftMs: number,
  gain = 0.6,
  noiseAmp = 0.02,
  seed = 99,
): Float32Array {
  const out = new Float32Array(src.length);
  const shiftSamples = Math.round((shiftMs * sampleRate) / 1000);
  const rng = makeRng(seed);

  for (let i = 0; i < out.length; i++) {
    const srcIdx = i - shiftSamples;
    const sig = srcIdx >= 0 && srcIdx < src.length ? src[srcIdx] * gain : 0;
    const noise = (rng() + rng() - 1) * noiseAmp;
    out[i] = sig + noise;
  }
  return out;
}

describe("audio-sync-acoustic: primitives", () => {
  it("computes 10ms RMS energy envelopes and handles invalid inputs", () => {
    const sr = 16_000;
    const pcm = new Float32Array(1600); // 100ms = 10 frames
    for (let i = 0; i < 160; i++) pcm[i] = 0.5;
    for (let i = 160; i < 320; i++) pcm[i] = i % 2 === 0 ? 1 : -1;
    pcm[320] = Number.NaN;

    const env = computeRmsEnvelope(pcm, sr, 10);
    expect(env.length).toBe(10);
    expect(env[0]).toBeCloseTo(0.5, 5);
    expect(env[1]).toBeCloseTo(1.0, 5);
    expect(env[2]).toBe(0);

    expect(computeRmsEnvelope(pcm, 0, 10).length).toBe(0);
    expect(computeRmsEnvelope(new Float32Array(10), sr, 10).length).toBe(0);
  });

  it("interpolates sub-frame peaks parabolically", () => {
    expect(parabolicPeak(0.8, 1.0, 0.8)).toBeCloseTo(0, 6);
    expect(parabolicPeak(0.8, 1.0, 0.9)).toBeGreaterThan(0);
    expect(parabolicPeak(0.9, 1.0, 0.8)).toBeLessThan(0);
    expect(parabolicPeak(1.0, 1.0, 1.0)).toBe(0);
  });

  it("extracts mono PCM from multi-channel AudioBufferLike", () => {
    const ch0 = new Float32Array([0.2, 0.4, 0.6]);
    const ch1 = new Float32Array([0.6, 0.8, 1.0]);
    const buf: AudioBufferLike = {
      sampleRate: 48_000,
      numberOfChannels: 2,
      getChannelData: (c) => (c === 0 ? ch0 : ch1),
    };
    const mono = extractMonoPcm(buf);
    expect(mono.sampleRate).toBe(48_000);
    expect(mono.samples[0]).toBeCloseTo(0.4, 5);
    expect(mono.samples[1]).toBeCloseTo(0.6, 5);
    expect(mono.samples[2]).toBeCloseTo(0.8, 5);
  });
});

describe("audio-sync-acoustic: latency delta detection", () => {
  const sr = 16_000;
  const ref = makeSpeechSignal(2800, sr, 42);

  it("measures +350ms acoustic delay within sub-10ms accuracy", () => {
    const mic = shiftAndNoise(ref, sr, 350, 0.5, 0.02, 101);
    const res = estimateAcousticDelta(ref, mic, { sampleRate: sr });

    expect(res.detected).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.correlation).toBeGreaterThan(0.85);
    expect(Math.abs(res.deltaMs - 350)).toBeLessThan(10);
  });

  it("measures -180ms acoustic lead within sub-10ms accuracy", () => {
    const mic = shiftAndNoise(ref, sr, -180, 0.5, 0.02, 102);
    const res = estimateAcousticDelta(ref, mic, { sampleRate: sr });

    expect(res.detected).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.correlation).toBeGreaterThan(0.85);
    expect(Math.abs(res.deltaMs - -180)).toBeLessThan(10);
  });

  it("achieves sub-10ms accuracy on non-frame-aligned fractional lags (+123ms, -47ms)", () => {
    const micPos = shiftAndNoise(ref, sr, 123, 0.6, 0.015, 201);
    const resPos = estimateAcousticDelta(ref, micPos, { sampleRate: sr });
    expect(resPos.detected).toBe(true);
    expect(Math.abs(resPos.deltaMs - 123)).toBeLessThan(5);

    const micNeg = shiftAndNoise(ref, sr, -47, 0.6, 0.015, 202);
    const resNeg = estimateAcousticDelta(ref, micNeg, { sampleRate: sr });
    expect(resNeg.detected).toBe(true);
    expect(Math.abs(resNeg.deltaMs - -47)).toBeLessThan(5);
  });

  it("handles AudioBufferLike inputs with different sample rates (48kHz ref vs 16kHz mic)", () => {
    const ref48 = makeSpeechSignal(2800, 48_000, 42);
    const refBuf: AudioBufferLike = {
      sampleRate: 48_000,
      numberOfChannels: 1,
      getChannelData: () => ref48,
    };
    const mic16 = shiftAndNoise(makeSpeechSignal(2800, 16_000, 42), 16_000, 240, 0.55, 0.02, 303);

    const res = estimateAcousticDelta(refBuf, mic16, { micSampleRate: 16_000 });
    expect(res.detected).toBe(true);
    expect(Math.abs(res.deltaMs - 240)).toBeLessThan(10);
  });
});

describe("audio-sync-acoustic: confidence gates", () => {
  const sr = 16_000;
  const ref = makeSpeechSignal(2400, sr, 7);

  it("rejects silent mic and silent reference", () => {
    const silent = new Float32Array(ref.length);
    const resMicSilent = estimateAcousticDelta(ref, silent, { sampleRate: sr });
    expect(resMicSilent.detected).toBe(false);
    expect(resMicSilent.reason).toBe("low-mic-energy");

    const resRefSilent = estimateAcousticDelta(silent, ref, { sampleRate: sr });
    expect(resRefSilent.detected).toBe(false);
    expect(resRefSilent.reason).toBe("low-ref-energy");
  });

  it("rejects uncorrelated background noise", () => {
    const rng = makeRng(777);
    const noise = new Float32Array(ref.length);
    for (let i = 0; i < noise.length; i++) {
      noise[i] = (rng() * 2 - 1) * 0.15;
    }

    const res = estimateAcousticDelta(ref, noise, { sampleRate: sr });
    expect(res.detected).toBe(false);
    expect(res.reason).toBe("low-correlation");
    expect(res.correlation).toBeLessThan(0.55);
  });

  it("rejects buffers shorter than minOverlapFrames", () => {
    const tiny = new Float32Array(800); // 50ms = 5 frames < 20
    const res = estimateAcousticDelta(tiny, tiny, { sampleRate: sr });
    expect(res.detected).toBe(false);
    expect(res.reason).toBe("insufficient-overlap");

    const corr = correlateEnvelopes(new Float32Array(5), new Float32Array(5));
    expect(corr.valid).toBe(false);
  });
});

describe("audio-sync-acoustic: smoothOffsetUpdate EMA + hysteresis", () => {
  it("locks on first valid detection and ignores noisy/rejected frames", () => {
    let state = createOffsetFilterState();
    expect(state.offsetMs).toBeNull();

    // Background noise rejected before lock
    const r0 = smoothOffsetUpdate(state, { detected: false, deltaMs: 220, correlation: 0.2 });
    expect(r0.updated).toBe(false);
    expect(r0.offsetMs).toBeNull();
    state = r0.state;

    // First valid detection locks immediately
    const r1 = smoothOffsetUpdate(state, { detected: true, deltaMs: 350, correlation: 0.9 });
    expect(r1.updated).toBe(true);
    expect(r1.offsetMs).toBe(350);
    state = r1.state;

    // Subsequent noise does not perturb the locked offset
    const r2 = smoothOffsetUpdate(state, { detected: false, deltaMs: -400, correlation: 0.15 });
    expect(r2.updated).toBe(false);
    expect(r2.offsetMs).toBe(350);
  });

  it("applies hysteresis deadband and smooth EMA tracking", () => {
    let state = createOffsetFilterState();
    state = smoothOffsetUpdate(state, { detected: true, deltaMs: 350, correlation: 0.9 }).state;

    // Within 5ms deadband -> ignored
    const jitter = smoothOffsetUpdate(state, { detected: true, deltaMs: 353, correlation: 0.9 });
    expect(jitter.updated).toBe(false);
    expect(jitter.offsetMs).toBe(350);

    // Outside deadband (370ms, diff = +20ms <= maxJumpMs) -> EMA with alpha=0.25 -> 355ms
    const drift = smoothOffsetUpdate(jitter.state, {
      detected: true,
      deltaMs: 370,
      correlation: 0.88,
    });
    expect(drift.updated).toBe(true);
    expect(drift.offsetMs).toBeCloseTo(355, 5);
  });

  it("requires confirmation before accepting a sudden jump > maxJumpMs", () => {
    let state = createOffsetFilterState();
    state = smoothOffsetUpdate(state, { detected: true, deltaMs: 100, correlation: 0.9 }).state;

    // Single outlier jump to 400ms is held pending confirmation
    const spike = smoothOffsetUpdate(state, { detected: true, deltaMs: 400, correlation: 0.85 });
    expect(spike.updated).toBe(false);
    expect(spike.offsetMs).toBe(100);

    // Second consistent detection confirms the new regime
    const confirmed = smoothOffsetUpdate(spike.state, {
      detected: true,
      deltaMs: 405,
      correlation: 0.86,
    });
    expect(confirmed.updated).toBe(true);
    expect(confirmed.offsetMs).toBeGreaterThan(100);
  });
});
