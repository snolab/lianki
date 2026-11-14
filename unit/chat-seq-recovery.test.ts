import { expect, test } from "bun:test";
import {
  createChatSeqRecovery,
  type ReplayEnvelope,
  type ReplayItem,
} from "../lib/chat-seq-recovery";
import type { ChatMessage } from "../lib/dev-eval";

const envelope = (extra: Partial<ReplayEnvelope> = {}): ReplayEnvelope => ({
  afterSeq: 0,
  throughSeq: 0,
  headSeq: 0,
  prunedThroughSeq: 0,
  thread: "owner",
  ...extra,
});
const line = (id: string, seq?: number, at = seq ?? 1): ChatMessage => ({
  id,
  seq,
  at,
  from: "owner",
  label: "",
  text: id,
  thread: "owner",
});
function fixture() {
  const ranges: { type: "replay"; afterSeq: number; throughSeq: number }[] = [];
  let batch = 2;
  let mode = "ok";
  const q = createChatSeqRecovery({
    batch: () => batch,
    request: (range) => {
      ranges.push(range);
      if (mode === "throw") throw Error("network");
      return mode !== "false";
    },
  });
  return {
    q,
    ranges,
    batch: (n: number) => {
      batch = n;
    },
    mode: (v: string) => {
      mode = v;
    },
  };
}

test("gaps recover in bounded order while out-of-order observations wait; coverage is not an acceptance or read cursor", () => {
  const h = fixture();
  expect(h.q.cursor()).toBeUndefined();
  expect(h.q.thread()).toBeUndefined();
  expect(h.q.prunedThrough()).toBe(0);
  h.q.observe(undefined);
  h.q.observe(0);
  h.q.observe(-1);
  h.q.observe(2); // Before authoritative initial history: do not invent its baseline.
  expect(h.ranges).toEqual([]);
  expect(h.q.history(envelope({ throughSeq: 2, headSeq: 2 }))).toEqual({
    valid: true,
    initial: true,
  });
  h.q.observe(5);
  h.q.observe(7);
  expect(h.ranges).toEqual([{ type: "replay", afterSeq: 2, throughSeq: 4 }]);
  h.q.history(envelope({ afterSeq: 2, throughSeq: 4, headSeq: 7, skipped: [{ from: 3, to: 4 }] }));
  expect(h.q.cursor()).toBe(5);
  expect(h.ranges.at(-1)).toEqual({ type: "replay", afterSeq: 5, throughSeq: 6 });
  h.q.history(envelope({ afterSeq: 5, throughSeq: 6, headSeq: 7 }));
  expect(h.q.cursor()).toBe(7);
  expect(h.ranges).toHaveLength(2);
});

test("pruned and explicitly nonvisible intervals close holes without replay loops", () => {
  const h = fixture();
  h.batch(1000);
  h.q.history(envelope({ headSeq: 600, prunedThroughSeq: 100 }));
  expect(h.ranges).toEqual([{ type: "replay", afterSeq: 100, throughSeq: 600 }]);
  h.q.history(
    envelope({
      afterSeq: 100,
      throughSeq: 600,
      headSeq: 600,
      prunedThroughSeq: 100,
      skipped: [
        { from: 101, to: 600 },
        { from: -1, to: 2 },
        { from: 5, to: 3 },
        { from: 601, to: 700 },
      ],
    }),
  );
  expect(h.q.cursor()).toBe(600);
  h.q.history(envelope({ afterSeq: 100, throughSeq: 600, headSeq: 600, prunedThroughSeq: 100 }));
  expect(h.ranges).toHaveLength(1);
  expect(
    h.q.merge([line("pruned", 100), line("kept", 601)], [line("also-pruned", 99)]).map((m) => m.id),
  ).toEqual(["kept"]);
});

test("network failure retries only on later events/reconnect, batch config is bounded, and no-progress replies cannot spin", () => {
  const h = fixture();
  h.mode("false");
  h.batch(Number.NaN);
  h.q.history(envelope({ afterSeq: 10, throughSeq: 10, headSeq: 13 }));
  expect(h.ranges.at(-1)).toEqual({ type: "replay", afterSeq: 10, throughSeq: 13 });
  h.mode("throw");
  h.batch(0);
  h.q.observe(14);
  expect(h.ranges.at(-1)).toEqual({ type: "replay", afterSeq: 10, throughSeq: 11 });
  h.mode("ok");
  h.q.disconnect();
  h.q.observe(15);
  const n = h.ranges.length;
  h.q.history(envelope({ afterSeq: 10, throughSeq: 10, headSeq: 15 }));
  expect(h.ranges).toHaveLength(n);
  h.q.disconnect();
  h.q.observe(16);
  expect(h.ranges).toHaveLength(n + 1);
});

test("thread changes discard old coverage and versions; malformed envelopes cannot claim coverage", () => {
  const h = fixture();
  for (const bad of [
    envelope({ afterSeq: -1 }),
    envelope({ afterSeq: 2 }),
    envelope({ throughSeq: 2 }),
    envelope({ prunedThroughSeq: 2 }),
  ])
    expect(h.q.history(bad).valid).toBe(false);
  h.q.history(envelope({ afterSeq: 3, throughSeq: 5, headSeq: 5 }));
  h.q.merge([], [line("same", 5)]);
  expect(h.q.history(envelope({ thread: "private", throughSeq: 1, headSeq: 1 }))).toEqual({
    valid: true,
    initial: true,
  });
  const fresh = { ...line("same", 1), thread: "private" };
  expect(h.q.merge([line("old", 5), line("legacy")], [fresh], true)).toEqual([fresh]);
  expect(h.q.thread()).toBe("private");
  expect(h.q.cursor()).toBe(1);
});

test("id+latest version merges edits in logical position and prevents tombstone resurrection", () => {
  const h = fixture();
  h.q.history(envelope());
  const old = [line("a", 2, 100), line("b", 5, 50)];
  expect(
    h.q
      .merge(old, [
        { ...line("a", 1, 100), text: "stale" },
        { ...line("b", 6, 50), text: "edited" },
      ])
      .map((m) => m.text),
  ).toEqual(["edited", "a"]);
  expect(h.q.merge(old, [{ id: "a", seq: 7, removed: true }]).map((m) => m.id)).toEqual(["b"]);
  expect(h.q.merge([old[0]!], [])).toEqual([]);
  expect(
    h.q.merge(
      [],
      [line("a", 2), line("a"), { id: "a", seq: 7, removed: false } as unknown as ReplayItem],
    ),
  ).toEqual([]);
  expect(h.q.merge([], [line("a", 8)])).toEqual([line("a", 8)]);
  const legacy = { ...line("legacy"), edited: { at: 300, by: "agent", count: 1 } };
  expect(
    h.q.merge([legacy], [{ ...legacy, edited: { at: 200, by: "agent", count: 1 }, text: "old" }]),
  ).toEqual([legacy]);
  const updated = { ...legacy, text: "new", edited: { at: 400, by: "agent", count: 2 } };
  expect(h.q.merge([legacy], [updated])).toEqual([updated]);
  expect(
    h.q.merge([], [
      null,
      { id: 1 },
      { ...line("foreign", 9), thread: "other" },
    ] as unknown as ReplayItem[]),
  ).toEqual([]);
  expect(h.q.merge([line("gone")], [], true)).toEqual([]);
  expect(h.q.merge([line("same")], [line("same", 10)], true)).toEqual([line("same", 10)]);
});

test("partial mutation heads do not claim a version; full snapshots recover missed preceding state", () => {
  const h = fixture();
  h.q.history(envelope({ throughSeq: 8, headSeq: 8 }));
  h.q.notice(undefined);
  h.q.notice(0);
  h.q.notice(10);
  expect(h.ranges).toEqual([{ type: "replay", afterSeq: 8, throughSeq: 10 }]);
  const original = line("a", 8, 1);
  const full = {
    ...line("a", 10, 1),
    text: "edit missed at 9",
    answer: { at: 10, label: "", source: "tap", thread: "owner", choices: {} },
  } as ChatMessage;
  expect(h.q.merge([original], [full])).toEqual([full]);
  expect(h.q.version("a")).toBe(10);
  expect(h.q.version("missing")).toBeUndefined();
  h.q.history(
    envelope({ afterSeq: 8, throughSeq: 10, headSeq: 10, skipped: [{ from: 9, to: 9 }] }),
  );
  expect(h.q.cursor()).toBe(10);
  const sameTime = [line("a", 1, 1), line("b", 2, 1)];
  const order = fixture().q;
  expect(
    order.merge(sameTime, [{ ...line("a", 100, 1), text: "new version" }]).map((m) => m.id),
  ).toEqual(["a", "b"]);
});
