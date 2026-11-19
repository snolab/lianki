import { describe, expect, test } from "bun:test";
import { startNativeSegment } from "../lib/words/native-audio-segment";

class Media extends EventTarget {
  src = "blob:private";
  duration = 30;
  currentTime = 0;
  readyState = 0;
  seeking = false;
  plays = 0;
  pauses = 0;
  reject = false;
  throws = false;
  play(): Promise<void> {
    this.plays++;
    if (this.throws) throw Error("play failed");
    return this.reject ? Promise.reject(Error("play blocked")) : Promise.resolve();
  }
  pause() {
    this.pauses++;
  }
  emit(name: string) {
    this.dispatchEvent(new Event(name));
  }
}
function setup(el = new Media(), range = { startMs: 1000, endMs: 1600 }, timeoutMs = 15000) {
  const controller = new AbortController();
  const results: boolean[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let id = 0;
  const cancel = startNativeSegment(el as unknown as HTMLAudioElement, range, {
    signal: controller.signal,
    timeoutMs,
    done: (ok) => results.push(ok),
    clock: {
      frame: (fn) => {
        frames.set(++id, fn);
        return id;
      },
      cancelFrame: (n) => {
        frames.delete(n);
      },
      timer: (fn) => {
        timers.set(++id, fn);
        return id;
      },
      clearTimer: (n) => {
        timers.delete(n as number);
      },
    },
  });
  return {
    el,
    controller,
    results,
    frames,
    timers,
    cancel,
    frame() {
      for (const [n, fn] of [...frames]) {
        frames.delete(n);
        fn(0);
      }
    },
    timeout() {
      for (const [n, fn] of [...timers]) {
        timers.delete(n);
        fn();
      }
    },
  };
}
describe("private native word segment", () => {
  test("metadata and seek complete before play; media clock cuts off once", () => {
    const s = setup();
    expect(s.el.plays).toBe(0);
    s.el.seeking = true;
    s.el.emit("loadedmetadata");
    expect(s.el.currentTime).toBe(1);
    expect(s.el.plays).toBe(0);
    s.el.seeking = false;
    s.el.emit("seeked");
    expect(s.el.plays).toBe(1);
    s.el.emit("playing");
    s.frame();
    expect(s.results).toEqual([]);
    s.el.currentTime = 1.6;
    s.frame();
    expect(s.results).toEqual([true]);
    s.el.emit("ended");
    s.el.emit("error");
    s.timeout();
    s.cancel();
    expect(s.results).toEqual([true]);
    expect(s.frames.size + s.timers.size).toBe(0);
  });
  test("loaded media and zero seek do not wait for a seeked event", () => {
    const el = new Media();
    el.readyState = 1;
    const s = setup(el, { startMs: 0, endMs: 400 });
    expect(el.plays).toBe(1);
    el.emit("playing");
    el.currentTime = 0.4;
    el.emit("timeupdate");
    expect(s.results).toEqual([true]);
  });
  test("abort or cancel during loading cannot later start or complete", () => {
    for (const byAbort of [true, false]) {
      const s = setup();
      if (byAbort) s.controller.abort();
      else s.cancel();
      s.el.emit("loadedmetadata");
      s.el.emit("playing");
      s.el.emit("seeked");
      s.frame();
      s.timeout();
      expect(s.el.plays).toBe(0);
      expect(s.results).toEqual([]);
      expect(s.frames.size + s.timers.size).toBe(0);
    }
  });
  test("invalid ranges and invalid media duration fail without playing", () => {
    for (const range of [
      { startMs: -1, endMs: 100 },
      { startMs: NaN, endMs: 100 },
      { startMs: 10, endMs: 10 },
      { startMs: 1, endMs: Infinity },
      { startMs: 10, endMs: 31000 },
    ]) {
      const s = setup(new Media(), range);
      s.el.emit("loadedmetadata");
      expect(s.el.plays).toBe(0);
      expect(s.results).toEqual([false]);
    }
    for (const duration of [NaN, Infinity, 0]) {
      const el = new Media();
      el.duration = duration;
      const s = setup(el);
      el.emit("loadedmetadata");
      expect(s.results).toEqual([false]);
    }
    expect(setup(new Media(), undefined, 0).results).toEqual([false]);
  });
  test("load timeout, decoding error and premature end report false once", () => {
    const timed = setup();
    timed.timeout();
    timed.timeout();
    expect(timed.results).toEqual([false]);
    const failed = setup();
    failed.el.emit("error");
    expect(failed.results).toEqual([false]);
    const ended = setup();
    ended.el.emit("loadedmetadata");
    ended.el.emit("playing");
    ended.el.emit("ended");
    expect(ended.results).toEqual([false]);
  });
  test("a rejected play promise and a thrown play call finish once", async () => {
    for (const throws of [false, true]) {
      const el = new Media();
      el.reject = !throws;
      el.throws = throws;
      const s = setup(el);
      el.emit("loadedmetadata");
      await Promise.resolve();
      expect(s.results).toEqual([false]);
    }
  });
  test("a late play rejection after abort cannot invoke a stale callback", async () => {
    const el = new Media();
    el.reject = true;
    const s = setup(el);
    el.emit("loadedmetadata");
    s.controller.abort();
    await Promise.resolve();
    expect(s.results).toEqual([]);
  });
  test("a reused pooled element is neither paused nor completed by old callbacks", () => {
    const s = setup();
    s.el.emit("loadedmetadata");
    s.el.emit("playing");
    s.el.src = "blob:next";
    const before = s.el.pauses;
    s.frame();
    expect(s.el.pauses).toBe(before);
    expect(s.results).toEqual([]);
    const late = setup();
    late.el.src = "blob:next";
    late.el.emit("error");
    late.el.emit("ended");
    expect(late.results).toEqual([]);
    expect(late.el.pauses).toBe(0);
  });
  test("already aborted signal never starts", () => {
    const el = new Media(),
      controller = new AbortController();
    controller.abort();
    const done: boolean[] = [];
    startNativeSegment(
      el as unknown as HTMLAudioElement,
      { startMs: 0, endMs: 100 },
      {
        signal: controller.signal,
        timeoutMs: 5000,
        done: (ok) => done.push(ok),
      },
    );
    el.emit("loadedmetadata");
    expect(el.plays).toBe(0);
    expect(done).toEqual([]);
  });
  test("a rejected media seek fails without playing", () => {
    const el = new Media();
    Object.defineProperty(el, "currentTime", {
      get: () => 0,
      set: () => {
        throw Error("seek rejected");
      },
    });
    const s = setup(el);
    el.emit("loadedmetadata");
    expect(el.plays).toBe(0);
    expect(s.results).toEqual([false]);
  });
  test("browser scheduling defaults cancel frames and expire stalled media", async () => {
    const oldFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const oldCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    let callback: FrameRequestCallback | undefined,
      cancelled = 0;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (fn: FrameRequestCallback) => {
        callback = fn;
        return 1;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => {
        cancelled++;
      },
    });
    try {
      const el = new Media();
      el.readyState = 1;
      const done: boolean[] = [];
      const cancel = startNativeSegment(
        el as unknown as HTMLAudioElement,
        { startMs: 0, endMs: 100 },
        {
          signal: new AbortController().signal,
          timeoutMs: 1000,
          done: (ok) => done.push(ok),
        },
      );
      el.emit("playing");
      callback?.(0);
      cancel();
      expect(cancelled).toBe(1);
      expect(done).toEqual([]);
      startNativeSegment(
        new Media() as unknown as HTMLAudioElement,
        { startMs: 0, endMs: 100 },
        {
          signal: new AbortController().signal,
          timeoutMs: 1,
          done: (ok) => done.push(ok),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(done).toEqual([false]);
    } finally {
      for (const [key, descriptor] of [
        ["requestAnimationFrame", oldFrame],
        ["cancelAnimationFrame", oldCancel],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
