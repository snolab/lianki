import { expect, test } from "bun:test";
import { sayNativeFirst, skipsNative, type NativeFirstDeps } from "../lib/words/native-first";
import type { NativeClip } from "../lib/words/native-audio-client";

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)));
  return { promise, resolve, reject };
}
const clip: NativeClip = { url: "blob:x", startMs: 1000, endMs: 2000, estimated: true };
const card = { listId: "l", term: "w" };
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(over: Partial<NativeFirstDeps> = {}) {
  const log: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const load = deferred<NativeClip | null>();
  const loads: AbortSignal[] = [];
  let play: { started: () => void; done: (p: boolean) => void; signal: AbortSignal } | null = null;
  const abort = new AbortController();
  const deps: NativeFirstDeps = {
    on: true,
    client: {
      ready: true,
      enabled: true,
      load: (_c, signal) => {
        loads.push(signal);
        return load.promise;
      },
    },
    card,
    startMs: 1000,
    signal: abort.signal,
    play: (_clip, signal, started, done) => {
      log.push("native");
      play = { started, done, signal };
    },
    synthetic: () => log.push("synthetic"),
    done: (p) => log.push(`done:${p}`),
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimer: (t) => void timers.delete(t as number),
    ...over,
  };
  const fire = () => {
    for (const [k, t] of [...timers]) {
      timers.delete(k);
      t.fn();
    }
  };
  return { deps, log, timers, load, loads, abort, fire, play: () => play! };
}

test("a slow archive: the synthetic voice speaks within the cap and the load is let go", async () => {
  const s = setup();
  sayNativeFirst(s.deps);
  expect(s.log).toEqual([]);
  expect([...s.timers.values()][0].ms).toBe(1000);
  s.fire(); // 1000 ms, still downloading
  expect(s.log).toEqual(["synthetic"]);
  expect(s.loads[0].aborted).toBe(true);
  // The archive arrives late: nothing plays over the synthetic voice.
  s.load.resolve(clip);
  await flush();
  expect(s.log).toEqual(["synthetic"]);
});

test("a ready recording plays and the cap stops counting once it is audible", async () => {
  const s = setup();
  sayNativeFirst(s.deps);
  s.load.resolve(clip);
  await flush();
  expect(s.log).toEqual(["native"]);
  s.play().started();
  expect(s.timers.size).toBe(0);
  s.fire();
  s.play().done(true);
  expect(s.log).toEqual(["native", "done:true"]);
  s.play().done(true);
  expect(s.log).toEqual(["native", "done:true"]);
});

test("a clip loaded but not audible by the cap falls back; a failed range falls back", async () => {
  const s = setup();
  sayNativeFirst(s.deps);
  s.load.resolve(clip);
  await flush();
  s.fire();
  expect(s.log).toEqual(["native", "synthetic"]);
  expect(s.play().signal.aborted).toBe(true);
  s.play().done(false);
  expect(s.log).toEqual(["native", "synthetic"]);

  const t = setup();
  sayNativeFirst(t.deps);
  t.load.resolve(clip);
  await flush();
  t.play().started();
  t.play().done(false);
  expect(t.log).toEqual(["native", "synthetic"]);
});

test("no recording, or a load that throws, says it synthetic at once", async () => {
  const s = setup();
  sayNativeFirst(s.deps);
  s.load.resolve(null);
  await flush();
  expect(s.log).toEqual(["synthetic"]);
  expect(s.timers.size).toBe(0);
  const t = setup();
  sayNativeFirst(t.deps);
  t.load.reject(Error("x"));
  await flush();
  expect(t.log).toEqual(["synthetic"]);
});

test("switch off, no card, no client or no recordings skip the recording entirely", () => {
  for (const over of [
    { on: false },
    { card: undefined },
    { client: null },
    { client: { ready: true, enabled: false, load: () => Promise.resolve(clip) } },
  ] as Partial<NativeFirstDeps>[]) {
    const s = setup(over);
    sayNativeFirst(s.deps);
    expect(s.log).toEqual(["synthetic"]);
    expect(s.loads).toHaveLength(0);
    expect(s.timers.size).toBe(0);
  }
  expect(
    skipsNative({
      on: true,
      card,
      client: { ready: false, enabled: false, load: async () => null },
    }),
  ).toBe(false);
});

test("a cut part says nothing: before it starts, while loading, after the cap", async () => {
  const s = setup();
  s.abort.abort();
  sayNativeFirst(s.deps);
  expect(s.log).toEqual([]);
  const t = setup();
  sayNativeFirst(t.deps);
  t.abort.abort();
  expect(t.timers.size).toBe(0);
  t.load.resolve(clip);
  await flush();
  t.fire();
  expect(t.log).toEqual([]);
});
