import { describe, expect, it } from "bun:test";
import {
  type ReadTiming,
  SPEECH_CHAR_MS,
  SPEECH_CPS,
  type UtterLike,
  createVoice,
  speechMs,
} from "@lianki/debug-chat/voice";
import { clipTiming, createCloudOut } from "@lianki/debug-chat/voice-out";
import {
  READ_SWEEP_CSS,
  SPEAKING_BG,
  SWEEP_ATTR,
  SWEEP_NAME,
  initialSweep,
  sweepFraction,
  sweepStep,
  sweepStyle,
} from "@lianki/debug-chat/read-sweep";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("speechMs: speechSynthesis's reading time, from the characters", () => {
  it("per character by script class (the same speeds as SPEECH_CPS), scaled by the rate", () => {
    expect(SPEECH_CHAR_MS.cjk).toBe(1000 / SPEECH_CPS.cjk);
    expect(SPEECH_CHAR_MS.other).toBe(1000 / SPEECH_CPS.other);
    expect(speechMs("")).toBe(0);
    expect(speechMs("你好")).toBeCloseTo(2 * SPEECH_CHAR_MS.cjk, 6);
    expect(speechMs("Hello")).toBeCloseTo(5 * SPEECH_CHAR_MS.other, 6);
    // Mixed: each character by its own class (kana and hangul are CJK too).
    expect(speechMs("Lianki です 안녕")).toBeCloseTo(
      8 * SPEECH_CHAR_MS.other + 4 * SPEECH_CHAR_MS.cjk,
      6,
    );
    expect(speechMs("Hello", 2)).toBeCloseTo(speechMs("Hello") / 2, 6);
    // A rate of 0 (or less) is taken as 0.1, never infinite.
    expect(speechMs("Hi", 0)).toBeCloseTo(speechMs("Hi") / 0.1, 6);
  });
});

describe("clipTiming: a clip's length over its speed", () => {
  it("the time left at its speed, and the share already behind it", () => {
    expect(clipTiming({ duration: 4, currentTime: 0, playbackRate: 2 })).toEqual({
      ms: 2000,
      done: 0,
    });
    expect(clipTiming({ duration: 4, currentTime: 1, playbackRate: 1 })).toEqual({
      ms: 3000,
      done: 0.25,
    });
    // No speed set: 1. Past the end: clamped.
    expect(clipTiming({ duration: 2, currentTime: 9 })).toEqual({ ms: 0, done: 1 });
  });
  it("unknown length (no metadata, a stream): null", () => {
    expect(clipTiming({ currentTime: 0 })).toBeNull();
    expect(clipTiming({ duration: Number.NaN, currentTime: 0 })).toBeNull();
    expect(clipTiming({ duration: Infinity, currentTime: 0 })).toBeNull();
    expect(clipTiming({ duration: 0, currentTime: 0 })).toBeNull();
  });
});

/** An audio element in memory: its metadata comes when the test says. */
class El {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  duration = Number.NaN;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
}

const cloud = (plain?: El) => {
  const el = new El();
  const out = createCloudOut({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      blob: async () => new Blob(["x"]),
    }),
    element: () => el,
    ...(plain ? { plain: () => plain } : {}),
    ctx: () => null,
    toUrl: () => "blob:x",
  });
  const got: (string | ReadTiming)[] = [];
  const ev = {
    onstart: () => void got.push("start"),
    ontiming: (t: ReadTiming) => void got.push(t),
    onend: () => {},
    onerror: () => {},
  };
  return { el, out, got, ev };
};

describe("voice-out: the clip's timing reaches the session", () => {
  it("a cloud clip: after it starts, its length at the reading speed (from the resume offset)", async () => {
    const c = cloud();
    c.out.play({ text: "Hello there.", lang: "en", at: 1, volume: 1, rate: 2 }, c.ev);
    await tick();
    c.el.duration = 5;
    c.el.onloadedmetadata?.();
    await tick();
    // at 1 s of 5, at twice the speed: 2 s left, a fifth behind.
    expect(c.got).toEqual(["start", { ms: 2000, done: 0.2 }]);
  });

  it("a cloud clip of unknown length: started, no timing (the static highlight)", async () => {
    const c = cloud();
    c.out.play({ text: "Stream.", lang: "en", at: 0, volume: 1 }, c.ev);
    await tick();
    c.el.duration = Infinity;
    c.el.onloadedmetadata?.();
    await tick();
    expect(c.got).toEqual(["start"]);
  });

  const pick = { kind: "eleven" as const, id: "x", preview: "https://example.test/x.mp3" };
  it("a preview: its length told when known, even after it started (metadata late)", async () => {
    const p = new El();
    const c = cloud(p);
    c.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1, pick }, c.ev);
    await tick();
    expect(c.got).toEqual(["start"]);
    p.duration = 3;
    p.currentTime = 0.5;
    p.onloadedmetadata?.();
    expect(c.got).toEqual(["start", { ms: 2500, done: 0.5 / 3 }]);
    expect(p.onloadedmetadata).toBeNull();
  });

  it("a preview: metadata before the start is told once, at the start", async () => {
    const p = new El();
    const c = cloud(p);
    c.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1, pick }, c.ev);
    p.duration = 2;
    p.onloadedmetadata?.();
    expect(c.got).toEqual([]);
    await tick();
    expect(c.got).toEqual(["start", { ms: 2000, done: 0 }]);
  });

  it("a preview stopped before its metadata: nothing told", async () => {
    const p = new El();
    const c = cloud(p);
    const pb = c.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1, pick }, c.ev);
    pb.stop();
    p.duration = 2;
    p.onloadedmetadata?.();
    await tick();
    expect(c.got).toEqual([]);
  });
});

describe("voice.ts: speechSynthesis's estimate through onTiming", () => {
  const harness = (rate = 1) => {
    const spoken: UtterLike[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      rate: () => rate,
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    v.setMic(true);
    const got: ReadTiming[] = [];
    const off = v.onTiming((t) => void got.push(t));
    return { v, spoken, got, off };
  };

  it("at its start: the sentence's estimated time at the utterance's speed", () => {
    const h = harness(2);
    h.v.reply("Hello world.");
    expect(h.got).toEqual([]);
    h.spoken[0]!.onstart?.();
    expect(h.got).toEqual([{ ms: speechMs("Hello world.", 2), done: 0 }]);
  });

  it("resumed part-way: the rest's time, and the share behind it", () => {
    const h = harness();
    h.v.reply("你好 big world");
    h.spoken[0]!.onstart?.();
    h.spoken[0]!.onboundary?.({ charIndex: 3, name: "word" });
    h.v.interrupt("tap");
    h.v.resume();
    const u = h.spoken[1]!;
    expect(u.text).toBe("big world");
    u.onstart?.();
    const all = speechMs("你好 big world");
    expect(h.got[1]!.ms).toBeCloseTo(speechMs("big world"), 6);
    expect(h.got[1]!.done).toBeCloseTo(speechMs("你好 ") / all, 6);
  });

  it("an utterance dropped meanwhile tells nothing; unsubscribed hears nothing", () => {
    const h = harness();
    h.v.reply("One.");
    const u = h.spoken[0]!;
    h.v.stop();
    u.onstart?.();
    expect(h.got).toEqual([]);
    h.off();
    h.v.reply("Two.");
    h.spoken.at(-1)!.onstart?.();
    expect(h.got).toEqual([]);
  });
});

describe("sweepStep: the speaking sentence's sweep", () => {
  it("a start alone: no length, a static highlight", () => {
    const s = sweepStep(initialSweep(), { type: "start", at: 1000 });
    expect(s.v).toBe(1);
    expect(s.dur).toBeNull();
    expect(sweepFraction(s, 1500)).toBeNull();
    expect(sweepStyle(s)).toBeNull();
  });

  it("its length: swept linearly from 0 to 100% over it", () => {
    let s = sweepStep(initialSweep(), { type: "start", at: 1000 });
    s = sweepStep(s, { type: "timing", at: 1000, ms: 2000, done: 0 });
    expect(s).toMatchObject({ v: 2, start: 1000, dur: 2000, delay: 0, pausedAt: null });
    expect(sweepFraction(s, 1000)).toBe(0);
    expect(sweepFraction(s, 2000)).toBe(0.5);
    expect(sweepFraction(s, 9000)).toBe(1);
    expect(sweepStyle(s)).toMatchObject({
      animationName: SWEEP_NAME,
      animationDuration: "2000ms",
      animationDelay: "0ms",
      animationTimingFunction: "linear",
      animationPlayState: "running",
      boxDecorationBreak: "slice",
    });
  });

  it("resumed part-way: the whole length, started at the share behind it (a negative delay)", () => {
    const s = sweepStep(initialSweep(), { type: "timing", at: 5000, ms: 1500, done: 0.25 });
    expect(s.dur).toBe(2000);
    expect(s.delay).toBe(-500);
    expect(s.start).toBe(4500);
    expect(sweepFraction(s, 5000)).toBe(0.25);
    expect(sweepStyle(s)?.animationDelay).toBe("-500ms");
  });

  it("a better length arriving late: restarted (a new key) from where it is now", () => {
    let s = sweepStep(initialSweep(), { type: "start", at: 0 });
    s = sweepStep(s, { type: "timing", at: 0, ms: 4000, done: 0 });
    // 1 s in, the clip's own length: 3 s left of 4 s.
    const v = s.v;
    s = sweepStep(s, { type: "timing", at: 1000, ms: 3000, done: 0.25 });
    expect(s.v).toBe(v + 1);
    expect(s.dur).toBe(4000);
    expect(s.delay).toBe(-1000);
    expect(sweepFraction(s, 1000)).toBe(0.25);
  });

  it("pause holds it (play-state paused), resume goes on from there", () => {
    let s = sweepStep(initialSweep(), { type: "timing", at: 0, ms: 1000, done: 0 });
    const v = s.v;
    s = sweepStep(s, { type: "pause", at: 400 });
    expect(sweepFraction(s, 900)).toBe(0.4);
    expect(sweepStyle(s)?.animationPlayState).toBe("paused");
    // Paused again: unchanged; the same element (no new key).
    expect(sweepStep(s, { type: "pause", at: 600 })).toBe(s);
    s = sweepStep(s, { type: "resume", at: 900 });
    expect(s.v).toBe(v);
    expect(s.pausedAt).toBeNull();
    expect(sweepFraction(s, 1000)).toBe(0.5);
    expect(sweepStyle(s)?.animationPlayState).toBe("running");
    // Resumed while playing: unchanged.
    expect(sweepStep(s, { type: "resume", at: 950 })).toBe(s);
  });

  it("a length told while paused stays paused; a new start clears the pause", () => {
    let s = sweepStep(initialSweep(), { type: "pause", at: 10 });
    s = sweepStep(s, { type: "timing", at: 20, ms: 1000, done: 0 });
    expect(s.pausedAt).toBe(20);
    expect(sweepStyle(s)?.animationPlayState).toBe("paused");
    s = sweepStep(s, { type: "start", at: 30 });
    expect(s.pausedAt).toBeNull();
  });

  it("no usable length (0, negative, infinite) changes nothing; a share near 1 stays finite", () => {
    const s = initialSweep();
    expect(sweepStep(s, { type: "timing", at: 0, ms: 0, done: 0 })).toBe(s);
    expect(sweepStep(s, { type: "timing", at: 0, ms: -1, done: 0 })).toBe(s);
    expect(sweepStep(s, { type: "timing", at: 0, ms: Infinity, done: 0 })).toBe(s);
    const near = sweepStep(s, { type: "timing", at: 0, ms: 10, done: 1 });
    expect(Number.isFinite(near.dur)).toBe(true);
    expect(near.dur).toBe(1000);
    expect(sweepStep(s, { type: "timing", at: 0, ms: 10, done: Number.NaN }).dur).toBe(10);
  });
});

describe("READ_SWEEP_CSS", () => {
  it("the keyframes grow the filled layer; reduced motion and data-motion=off get the static highlight", () => {
    expect(READ_SWEEP_CSS).toContain(`@keyframes ${SWEEP_NAME}`);
    expect(READ_SWEEP_CSS).toContain("background-size:0% 100%, 100% 100%");
    expect(READ_SWEEP_CSS).toContain("background-size:100% 100%, 100% 100%");
    expect(READ_SWEEP_CSS).toContain(
      `@media (prefers-reduced-motion: reduce){[${SWEEP_ATTR}]{animation:none!important;background:${SPEAKING_BG}!important}}`,
    );
    expect(READ_SWEEP_CSS).toContain(`html[data-motion="off"] [${SWEEP_ATTR}]`);
    // Colours in oklch, light and dark.
    expect(SPEAKING_BG).toMatch(/^light-dark\(oklch\(.+\), oklch\(.+\)\)$/);
    const st = sweepStyle(sweepStep(initialSweep(), { type: "timing", at: 0, ms: 1, done: 0 }))!;
    expect(String(st.backgroundImage)).toMatch(/light-dark\(oklch/);
    expect(String(st.backgroundImage)).not.toMatch(/rgb|#[0-9a-f]{3}/i);
  });
});
