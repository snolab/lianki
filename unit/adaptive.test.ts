import { afterEach, describe, expect, it } from "bun:test";
import {
  ADAPT_KEY,
  LIMIT,
  NORMAL,
  POLICY,
  VAD_THRESHOLDS,
  WHISPER,
  WHISPER_KEY,
  type WhisperMode,
  adaptPolicy,
  createAdaptive,
  frameDb,
  limiterCurve,
  setVadThresholds,
  vadParams,
  vadThresholds,
  vadThresholdsOf,
  voiceAdapt,
  whisperMode,
} from "@lianki/debug-chat/adaptive";

/** A 512-sample frame at this RMS dBFS (a constant signal). */
const at = (db: number) => new Float32Array(512).fill(10 ** (db / 20));

describe("adaptive whisper mode", () => {
  it("frameDb, the limiter curve, and the policy's overrides", () => {
    expect(frameDb(at(-30))).toBeCloseTo(-30, 5);
    expect(frameDb(new Float32Array(0))).toBeLessThan(-100);
    const c = limiterCurve(5);
    expect(c[0]).toBeCloseTo(-LIMIT * Math.tanh(1 / LIMIT), 6);
    expect(c[2]).toBe(0);
    expect(Math.max(...limiterCurve(101))).toBeLessThan(LIMIT);
    expect(adaptPolicy({ ENTER_LEVEL: -32, MIN_SNR: "x", NOPE: 1 })).toEqual({
      ...POLICY,
      ENTER_LEVEL: -32,
    });
    expect(adaptPolicy(null)).toEqual(POLICY);
  });

  it("a quiet room and a soft voice enter whisper; the gain rises 0.5 dB a frame", () => {
    const a = createAdaptive({ mode: () => "auto" });
    const seen: boolean[] = [];
    a.subscribe((s) => seen.push(s.whisper));
    // The room: −65 dB, nobody speaking.
    for (let i = 0; i < 400; i++) a.frame(at(-65), 0, false);
    expect(a.state().floorDb).toBeLessThan(-60);
    expect(a.state().whisper).toBe(false);
    // A soft voice at −40 dB: the 90th percentile walks down to it.
    let g = 0;
    for (let i = 0; i < 80; i++) g = a.frame(at(-40 + g), 0.9, true);
    const s = a.state();
    expect(s.whisper).toBe(true);
    expect(s.levelDb).toBeLessThan(-34);
    expect(s.gainDb).toBeGreaterThan(0);
    expect(s.endpointMs).toBe(WHISPER.endpointMs);
    // Captured when it switched: the start settings wait for the pause.
    expect(a.vad().positiveSpeechThreshold).toBe(NORMAL.positiveSpeechThreshold);
    a.frame(at(-65 + g), 0, false);
    expect(a.vad()).toEqual({
      positiveSpeechThreshold: 0.35,
      negativeSpeechThreshold: 0.25,
      minSpeechMs: 150,
    });
    expect(seen).toContain(true);
    // Never more than 0.5 dB up in a frame.
    const b = createAdaptive({ mode: () => "force" });
    let prev = 0;
    for (let i = 0; i < 30; i++) {
      const next = b.frame(at(-40 + prev), 0.9, true);
      expect(next - prev).toBeLessThanOrEqual(0.5 + 1e-9);
      prev = next;
    }
    expect(prev).toBeGreaterThan(5);
  });

  it("a loud voice or a noisy room leaves it; the gain falls fast", () => {
    const a = createAdaptive({ mode: () => "auto" });
    for (let i = 0; i < 400; i++) a.frame(at(-65), 0, false);
    let g = 0;
    for (let i = 0; i < 80; i++) g = a.frame(at(-40 + g), 0.9, false);
    expect(a.state().whisper).toBe(true);
    // He speaks up: −20 dB raises the level by 2.7 dB a frame.
    for (let i = 0; i < 10; i++) g = a.frame(at(-20 + g), 0.9, false);
    expect(a.state().whisper).toBe(false);
    for (let i = 0; i < 6; i++) g = a.frame(at(-20 + g), 0.9, false);
    expect(g).toBe(0);
    expect(a.vad().minSpeechMs).toBe(NORMAL.minSpeechMs);
    // A noisy room never enters it.
    const n = createAdaptive({ mode: () => "auto" });
    for (let i = 0; i < 400; i++) n.frame(at(-40), 0, false);
    for (let i = 0; i < 80; i++) n.frame(at(-38), 0.9, false);
    expect(n.state().whisper).toBe(false);
  });

  it("learns nothing and never raises the gain while the agent speaks", () => {
    let speaking = true;
    const a = createAdaptive({ mode: () => "force", speaking: () => speaking });
    for (let i = 0; i < 50; i++) expect(a.frame(at(-50), 0.9, true)).toBe(0);
    expect(a.state().levelDb).toBe(-20);
    expect(a.state().floorDb).toBe(-60);
    speaking = false;
    let g = 0;
    for (let i = 0; i < 20; i++) g = a.frame(at(-50 + g), 0.9, true);
    expect(g).toBeGreaterThan(0);
  });

  it("the override: force and off win over the policy, live", () => {
    let m: WhisperMode = "force";
    const a = createAdaptive({ mode: () => m });
    a.frame(at(-20), 0, false);
    expect(a.state()).toMatchObject({ mode: "force", whisper: true, endpointMin: 0.15 });
    m = "off";
    a.frame(at(-20), 0, false);
    expect(a.state()).toMatchObject({ mode: "off", whisper: false, endpointMargin: 0.25 });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[ADAPT_KEY];
  });

  it("whisperMode reads lk:voice-whisper; voiceAdapt is one per page", () => {
    const store = new Map<string, string>();
    const had = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    try {
      expect(whisperMode()).toBe("auto");
      store.set(WHISPER_KEY, "force");
      expect(whisperMode()).toBe("force");
      store.set(WHISPER_KEY, "off");
      expect(whisperMode()).toBe("off");
      store.set(WHISPER_KEY, "junk");
      expect(whisperMode()).toBe("auto");
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("blocked");
        },
      });
      expect(whisperMode()).toBe("auto");
    } finally {
      if (had === undefined) delete (globalThis as Record<string, unknown>).localStorage;
      else
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          writable: true,
          value: had,
        });
    }
    const one = voiceAdapt(() => false);
    expect(voiceAdapt()).toBe(one);
    const off = one.subscribe(() => {});
    off();
  });

  describe("live VAD thresholds (config stt.vad*)", () => {
    afterEach(() => {
      setVadThresholds({});
      delete (globalThis as Record<string, unknown>).__lkVoiceAdapt;
    });

    it("defaults: Silero's own 0.5 / 0.35, whisper 0.35 / 0.25 (owner, 2026-11-15)", () => {
      expect(VAD_THRESHOLDS).toEqual({
        normal: { positive: 0.5, negative: 0.35 },
        whisper: { positive: 0.35, negative: 0.25 },
      });
      expect(vadThresholds()).toEqual(VAD_THRESHOLDS);
      expect(vadParams(false)).toEqual(NORMAL);
      expect(vadParams(true)).toEqual(WHISPER);
    });

    it("validates: out of range reads as the default; negative stays below positive", () => {
      expect(
        vadThresholdsOf({ normal: { positive: 2, negative: "x" }, whisper: { positive: 0.01 } }),
      ).toEqual(VAD_THRESHOLDS);
      const t = vadThresholdsOf({
        normal: { positive: 0.6, negative: 0.7 },
        whisper: { positive: 0.3, negative: 0.3 },
      });
      expect(t.normal).toEqual({ positive: 0.6, negative: expect.closeTo(0.55, 9) });
      expect(t.whisper).toEqual({ positive: 0.3, negative: expect.closeTo(0.25, 9) });
      expect(vadThresholdsOf({ normal: { positive: 0.05, negative: 0.9 } }).normal.negative).toBe(
        0,
      );
    });

    it("reach vad(), the page override winning; the page estimator is refreshed", () => {
      const a = voiceAdapt(() => false);
      const seen: number[] = [];
      a.subscribe((s) => seen.push(s.positiveSpeechThreshold));
      setVadThresholds({ normal: { positive: 0.7, negative: 0.5 } });
      expect(a.vad()).toEqual({
        positiveSpeechThreshold: 0.7,
        negativeSpeechThreshold: 0.5,
        minSpeechMs: NORMAL.minSpeechMs,
      });
      expect(seen).toEqual([0.7]);
      // The same values again: no refresh.
      setVadThresholds({ normal: { positive: 0.7, negative: 0.5 } });
      expect(seen).toEqual([0.7]);
      (globalThis as Record<string, unknown>).__lkVoiceAdapt = {
        NORMAL_POSITIVE: 0.9,
        WHISPER_NEGATIVE: 0.1,
      };
      expect(a.vad().positiveSpeechThreshold).toBe(0.9);
      expect(a.vad().negativeSpeechThreshold).toBe(0.5);
      expect(vadParams(true).negativeSpeechThreshold).toBe(0.1);
      // An injected source replaces both.
      const b = createAdaptive({
        params: (w) => ({ ...(w ? WHISPER : NORMAL), positiveSpeechThreshold: 0.42 }),
      });
      expect(b.vad().positiveSpeechThreshold).toBe(0.42);
    });
  });
});
