import { describe, expect, it } from "bun:test";
import {
  READ_KEEP,
  RESUME_MAX_AGE_MS,
  readingLeft,
  toResume,
  initialRead,
  readStep,
  sentenceCount,
  sentenceRanges,
  sentenceState,
  type ReadEvent,
  type ReadProgress,
} from "@lianki/debug-chat/read-progress";

const run = (p: ReadProgress, ...evs: ReadEvent[]) => evs.reduce(readStep, p);

describe("readStep: following the voice queue", () => {
  it("a reply read through: each sentence speaking, then spoken", () => {
    let p = run(initialRead(), { type: "queued", n: 3 }, { type: "enqueue", id: "a", n: 3 });
    expect(p.unmatched).toBe(0);
    p = readStep(p, { type: "start" });
    expect(sentenceState(p, "a", 0)).toBe("speaking");
    p = run(p, { type: "queued", n: 2 }, { type: "start" });
    expect(sentenceState(p, "a", 0)).toBe("spoken");
    expect(sentenceState(p, "a", 1)).toBe("speaking");
    expect(sentenceState(p, "a", 2)).toBe("unread");
    p = run(p, { type: "queued", n: 1 }, { type: "start" }, { type: "queued", n: 0 });
    expect(p.done).toEqual({ a: 3 });
    expect(p.speaking).toBeNull();
    expect([0, 1, 2].map((i) => sentenceState(p, "a", i))).toEqual(["spoken", "spoken", "spoken"]);
  });

  it("a pause and resume keeps the same sentence current (the count does not move)", () => {
    let p = run(
      initialRead(),
      { type: "queued", n: 2 },
      { type: "enqueue", id: "a", n: 2 },
      { type: "start" },
    );
    p = run(p, { type: "queued", n: 1 }, { type: "start" }); // on the second
    // Paused: no count change. Resumed: it starts again.
    p = readStep(p, { type: "start" });
    expect(sentenceState(p, "a", 1)).toBe("speaking");
    expect(p.done).toEqual({ a: 1 });
  });

  it("Stop reading (the queue cleared at once): what was left stays unread", () => {
    let p = run(
      initialRead(),
      { type: "queued", n: 3 },
      { type: "enqueue", id: "a", n: 3 },
      { type: "start" },
    );
    p = readStep(p, { type: "queued", n: 0 });
    expect(p.done).toEqual({});
    expect(p.queue).toEqual([]);
    expect(p.speaking).toBeNull();
  });

  it("a second reply queues behind the first, and counts arriving before the message wait", () => {
    let p = run(initialRead(), { type: "queued", n: 1 }); // the message not seen yet
    expect(p.unmatched).toBe(1);
    p = run(p, { type: "enqueue", id: "a", n: 1 }, { type: "start" }, { type: "queued", n: 3 });
    p = readStep(p, { type: "enqueue", id: "b", n: 2 });
    p = run(p, { type: "queued", n: 2 }, { type: "start" });
    expect(sentenceState(p, "a", 0)).toBe("spoken");
    expect(sentenceState(p, "b", 0)).toBe("speaking");
    expect(readStep(p, { type: "queued", n: 2 })).toBe(p); // nothing moved
    expect(readStep(p, { type: "enqueue", id: "c", n: 0 })).toBe(p);
    expect(readStep(initialRead(), { type: "start" }).speaking).toBeNull();
  });

  it("a count shrinking past what is mirrored only spends the unclaimed ones", () => {
    const p = run(initialRead(), { type: "queued", n: 2 }, { type: "queued", n: 1 });
    expect(p.unmatched).toBe(1);
    expect(p.done).toEqual({});
  });

  it("keeps at most READ_KEEP messages' counts, dropping the oldest", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < READ_KEEP; i++) many[`m${i}`] = 1;
    let p = run(initialRead(many), { type: "queued", n: 1 }, { type: "enqueue", id: "new", n: 1 });
    p = run(p, { type: "start" }, { type: "queued", n: 0 });
    expect(Object.keys(p.done)).toHaveLength(READ_KEEP);
    expect(p.done.new).toBe(1);
    expect(p.done.m0).toBeUndefined();
  });
});

describe("sentences as the voice cuts them", () => {
  it("sentenceCount matches the voice queue's units", () => {
    expect(sentenceCount("One. Two! Three?")).toBe(3);
    expect(sentenceCount("好的。我明白了")).toBe(2);
    expect(sentenceCount("")).toBe(0);
  });

  it("sentenceRanges cover the original text exactly, gaps going with the sentence before", () => {
    const t = "One.  Two!\nThree";
    const r = sentenceRanges(t);
    expect(r.map((x) => t.slice(x.start, x.end))).toEqual(["One.  ", "Two!\n", "Three"]);
    expect(r.map((x) => t.slice(x.start, x.end)).join("")).toBe(t);
    expect(sentenceRanges("")).toEqual([]);
    expect(sentenceRanges("   ")).toEqual([{ start: 0, end: 3 }]);
  });
});

describe("resuming after a reload", () => {
  it("readingLeft: per message, its first unread sentence (the current one restarts)", () => {
    let p = run(initialRead(), { type: "queued", n: 3 }, { type: "enqueue", id: "a", n: 3 });
    p = run(p, { type: "start" }, { type: "queued", n: 2 }, { type: "start" }); // on a's second
    p = run(p, { type: "queued", n: 4 }, { type: "enqueue", id: "b", n: 2 });
    expect(readingLeft(p, new Map([["a", 1_000]]))).toEqual([
      { id: "a", from: 1, at: 1_000 },
      { id: "b", from: 0, at: 0 },
    ]);
  });

  it("a resumed reply's sentences count from where it stopped", () => {
    let p = run(initialRead({ a: 1 }), { type: "queued", n: 2 });
    p = readStep(p, { type: "enqueue", id: "a", n: 2, from: 1 });
    p = run(p, { type: "start" });
    expect(sentenceState(p, "a", 0)).toBe("spoken");
    expect(sentenceState(p, "a", 1)).toBe("speaking");
    p = run(p, { type: "queued", n: 1 }, { type: "start" }, { type: "queued", n: 0 });
    expect(p.done).toEqual({ a: 3 });
  });

  it("toResume: only replies queued in the last 10 minutes", () => {
    const now = 1_000_000;
    expect(
      toResume(
        [
          { id: "fresh", from: 1, at: now - 60_000 },
          { id: "old", from: 0, at: now - RESUME_MAX_AGE_MS },
          { id: "unknown", from: 0, at: 0 },
        ],
        now,
      ).map((r) => r.id),
    ).toEqual(["fresh"]);
  });
});
