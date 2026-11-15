import { describe, expect, test } from "bun:test";
import {
  advanceRead,
  intersectsReadRect,
  readersFor,
  validReadSeq,
} from "../packages/debug-chat/src/read-receipts";

describe("visible read watermarks", () => {
  test("only safe positive server sequences count", () => {
    for (const value of [undefined, "3", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(validReadSeq(value)).toBe(false);
    expect(validReadSeq(1)).toBe(true);
  });
  test("hidden delivery cannot advance; first actual observation emits", () => {
    const state = { seen: 0, sent: 0, at: null };
    expect(advanceRead(state, 9, 0, false, 2000)).toEqual({ state });
    expect(advanceRead(state, 9, 0, true, 2000)).toEqual({
      state: { seen: 9, sent: 9, at: 0 },
      emit: 9,
    });
    expect(advanceRead(state, NaN, 0, true, 2000)).toEqual({ state });
  });
  test("coalesces highest visible seq with a two second minimum, never moves backwards", () => {
    const initial = { seen: 3, sent: 3, at: 0 };
    const pending = advanceRead(initial, 7, 100, true, 1);
    expect(pending).toEqual({ state: { seen: 7, sent: 3, at: 0 }, wait: 1900 });
    expect(advanceRead(pending.state, 5, 1500, true, NaN).wait).toBe(500);
    expect(advanceRead(pending.state, 0, 2000, false, 2000)).toEqual({ state: pending.state });
    const flushed = advanceRead(pending.state, 0, 2000, true, 2000);
    expect(flushed).toEqual({ state: { seen: 7, sent: 7, at: 2000 }, emit: 7 });
    expect(advanceRead(flushed.state, 2, 2200, true, 2000)).toEqual({ state: flushed.state });
    expect(advanceRead(initial, 8, 2000, true, 3000).wait).toBe(1000);
  });
  test("scope reset has an independent watermark", () => {
    expect(advanceRead({ seen: 0, sent: 0, at: null }, 1, 100, true, 2000).emit).toBe(1);
  });
});

test("only actual text rectangles intersecting viewport and scroller count", () => {
  const clip = { top: 10, bottom: 90, left: 10, right: 90 };
  const rect = { top: 20, bottom: 30, left: 20, right: 30 };
  expect(intersectsReadRect([], clip)).toBe(false);
  expect(intersectsReadRect([rect], clip)).toBe(true);
  expect(intersectsReadRect([{ ...rect, bottom: 20 }], clip)).toBe(false);
  expect(intersectsReadRect([{ ...rect, right: 20 }], clip)).toBe(false);
  expect(intersectsReadRect([{ ...rect, top: 90, bottom: 100 }], clip)).toBe(false);
  expect(intersectsReadRect([{ ...rect, left: 90, right: 100 }], clip)).toBe(false);
  expect(
    intersectsReadRect(
      [
        { ...rect, top: 0, bottom: 10 },
        { ...rect, top: 89, bottom: 100 },
      ],
      clip,
    ),
  ).toBe(true);
});

test("receipt dots require owner-thread verdict and one maximum cursor per participant", () => {
  const participants = [
    { key: "a", name: "old", lastReadSeq: 4 },
    { key: "a", name: "new", lastReadSeq: 9 },
    { key: "a", name: "stale", lastReadSeq: 5 },
    { key: "b", name: "behind", lastReadSeq: 3 },
    { key: "c", name: "legacy" },
    { key: "d", name: "malformed", lastReadSeq: 1.5 },
  ];
  expect(readersFor(4, participants, false)).toEqual([]);
  expect(readersFor(undefined, participants, true)).toEqual([]);
  expect(readersFor(4, participants, true)).toEqual([participants[1]!]);
  expect(readersFor(10, participants, true)).toEqual([]);
});

test("current page is hidden while another own-account page can appear", () => {
  const self = { key: "page:self", lastReadSeq: 9, self: true as const };
  const other = { key: "page:other", lastReadSeq: 9 };
  expect(readersFor(5, [self, other], true)).toEqual([other]);
  expect(readersFor(5, [self], true)).toEqual([]);
});
