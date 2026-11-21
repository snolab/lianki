import { expect, test } from "bun:test";
import { playClip } from "../lib/words/play-clip";

type El = Parameters<typeof playClip>[0];
const el = (play: () => Promise<void>) => ({ play, onended: null, onerror: null }) as unknown as El;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("a rejected play() ends the part instead of stalling the card", async () => {
  const log: boolean[] = [];
  const e = el(() => Promise.reject(Error("NotAllowedError")));
  playClip(e, { done: (p) => log.push(p), current: () => true });
  await flush();
  expect(log).toEqual([false]);
  // A late error event after the refusal is not a second end.
  (e.onerror as () => void)?.();
  expect(log).toEqual([false]);
});

test("a rejected play() hands the part on when there is somewhere to go", async () => {
  const log: string[] = [];
  playClip(
    el(() => Promise.reject(Error("x"))),
    { done: (p) => log.push(`done:${p}`), refused: () => log.push("device"), current: () => true },
  );
  await flush();
  expect(log).toEqual(["device"]);
  const thrown: string[] = [];
  playClip(
    el(() => {
      throw Error("sync");
    }),
    { done: (p) => thrown.push(`done:${p}`), current: () => true },
  );
  expect(thrown).toEqual(["done:false"]);
});

test("ended reports once; a cut part reports nothing", async () => {
  const log: boolean[] = [];
  const e = el(() => Promise.resolve());
  playClip(e, { done: (p) => log.push(p), current: () => true });
  await flush();
  const ended = e.onended as () => void;
  ended();
  ended();
  expect(log).toEqual([true]);
  expect(e.onended).toBeNull();
  let live = true;
  const cut: boolean[] = [];
  const f = el(() => Promise.reject(Error("x")));
  playClip(f, { done: (p) => cut.push(p), current: () => live });
  live = false;
  await flush();
  expect(cut).toEqual([]);
  const g = el(() => Promise.resolve());
  const errs: boolean[] = [];
  playClip(g, { done: (p) => errs.push(p), current: () => true });
  (g.onerror as () => void)();
  expect(errs).toEqual([false]);
});

test("a media load or decode error falls back once even when play rejects later", async () => {
  const log: string[] = [];
  let reject!: (reason: Error) => void;
  const e = el(
    () =>
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
  );
  playClip(e, {
    done: (p) => log.push(`done:${p}`),
    refused: () => log.push("device"),
    current: () => true,
  });
  const error = e.onerror as () => void;
  error();
  error();
  reject(Error("decode failed"));
  await flush();
  expect(log).toEqual(["device"]);
  expect(e.onerror).toBeNull();
  expect(e.onended).toBeNull();
});

test("a stale media error cannot fall back over the next word", () => {
  const log: string[] = [];
  let current = true;
  const e = el(() => Promise.resolve());
  playClip(e, {
    done: () => log.push("done"),
    refused: () => log.push("device"),
    current: () => current,
  });
  current = false;
  (e.onerror as () => void)();
  expect(log).toEqual([]);
});
