import { describe, expect, test } from "bun:test";
import { PartnerTurn } from "../workers/push/src/partner-turn";
import { splitHandoff } from "../lib/partner-coordination";

function setup(reply?: (ids: string[], current: () => boolean) => Promise<void>, maxLines = 3) {
  let now = 0;
  const jobs = new Map<object, { at: number; fn(): void }>();
  const calls: string[][] = [];
  let failed = 0;
  const turns = new PartnerTurn<string>({
    timer: {
      set: (fn, ms) => {
        const key = {};
        jobs.set(key, { at: now + ms, fn });
        return key;
      },
      clear: (key) => {
        jobs.delete(key as object);
      },
    },
    now: () => now,
    delayMs: 8,
    maxWaitMs: 30,
    maxLines,
    reply: async (_thread, lines, _page, current) => {
      calls.push(lines.map((x) => x.id));
      await reply?.(
        lines.map((x) => x.id),
        current,
      );
    },
    failed: () => {
      failed++;
    },
  });
  return {
    turns,
    calls,
    failed: () => failed,
    add: (id: string, spoken = true, thread = "account") =>
      turns.add(thread, { id, spoken, at: now }, "page"),
    tick: async (ms: number) => {
      now += ms;
      for (const [key, job] of jobs)
        if (job.at <= now) {
          jobs.delete(key);
          job.fn();
        }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("shared Partner turns", () => {
  test("speech fragments coalesce, identical ids do not restart the pause", async () => {
    const s = setup();
    s.add("a");
    await s.tick(4);
    s.add("b");
    await s.tick(4);
    s.add("b");
    expect(s.calls).toEqual([]);
    await s.tick(4);
    expect(s.calls).toEqual([["a", "b"]]);
  });
  test("typed messages flush immediately and accounts stay isolated", async () => {
    const s = setup();
    s.add("speech", true, "one");
    await s.add("typed", false, "two");
    expect(s.calls).toEqual([["typed"]]);
    await s.tick(8);
    expect(s.calls).toEqual([["typed"], ["speech"]]);
  });
  test("a newer line invalidates a slow answer but preserves its source ids", async () => {
    let resolve!: () => void;
    let firstCurrent!: () => boolean;
    const s = setup(async (_ids, current) => {
      firstCurrent ??= current;
      if (s.calls.length === 1)
        await new Promise<void>((r) => {
          resolve = r;
        });
    });
    const first = s.add("a", false);
    expect(firstCurrent()).toBe(true);
    const second = s.add("b", false);
    expect(firstCurrent()).toBe(false);
    resolve();
    await first;
    await second;
    expect(s.calls).toEqual([["a"], ["a", "b"]]);
  });
  test("a failed model does not hold subsequent messages", async () => {
    const s = setup(async () => {
      throw Error("offline");
    });
    await s.add("a", false);
    await s.add("b", false);
    expect(s.calls).toEqual([["a"], ["b"]]);
    expect(s.failed()).toBe(2);
  });
  test("cancel invalidates pending and in-flight turns", async () => {
    const s = setup();
    s.add("a");
    s.turns.cancel("account");
    await s.tick(30);
    expect(s.calls).toEqual([]);
  });
  test("unnamed continuations belong only to an open speech pause, not an in-flight answer", async () => {
    let finish!: () => void;
    const s = setup(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    expect(s.turns.pendingSpeech("account")).toBe(false);
    s.add("named");
    expect(s.turns.pendingSpeech("account")).toBe(true);
    expect(s.turns.pendingSpeech("other-account")).toBe(false);
    await s.tick(8);
    expect(typeof finish).toBe("function");
    expect(s.turns.pendingSpeech("account")).toBe(false);
    finish();
    await Promise.resolve();
    expect(s.turns.pendingSpeech("account")).toBe(false);
    s.add("next");
    s.turns.cancel("account");
    expect(s.turns.pendingSpeech("account")).toBe(false);
  });
  test("the line bound forces a flush without waiting for silence", async () => {
    const s = setup();
    s.add("a");
    s.add("b");
    await s.add("c");
    expect(s.calls).toEqual([["a", "b", "c"]]);
  });
  test("continuous speech cannot extend the maximum wait", async () => {
    const s = setup(undefined, 12);
    s.add("a");
    await s.tick(7);
    s.add("b");
    await s.tick(7);
    s.add("c");
    await s.tick(7);
    s.add("d");
    await s.tick(7);
    s.add("e");
    expect(s.calls).toEqual([]);
    await s.tick(2);
    expect(s.calls).toEqual([["a", "b", "c", "d", "e"]]);
  });
});

test("a malformed or oversized model handoff keeps the raw request as fallback", () => {
  expect(splitHandoff('答复<handoff>{"text":"整理后的请求"}</handoff>', "raw")).toEqual({
    text: "答复",
    summary: "整理后的请求",
  });
  expect(splitHandoff("答复<handoff>oops", "raw")).toEqual({ text: "答复", summary: "raw" });
  expect(splitHandoff("答复<handoff>{oops}</handoff>", "raw")).toEqual({
    text: "答复",
    summary: "raw",
  });
  expect(
    splitHandoff(`ok<handoff>${JSON.stringify({ text: "x".repeat(4001) })}</handoff>`, "raw")
      .summary,
  ).toBe("raw");
});
