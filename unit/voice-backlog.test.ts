// The read-aloud backlog (owner, 2026-11-14): a long queue reads faster, and a
// very long one skips older lines to read the newest (packages/debug-chat/src/voice.ts).
import { describe, expect, it } from "bun:test";
import {
  BACKLOG_FROM,
  BACKLOG_FULL,
  BACKLOG_MAX_BOOST,
  BACKLOG_SKIP,
  RATE_CEILING,
  backlogBoost,
  backlogSkip,
  effectiveRate,
} from "@lianki/debug-chat/voice";

describe("backlogBoost / effectiveRate", () => {
  it("his own rate for a short queue, rising linearly to the max boost", () => {
    expect(backlogBoost(0)).toBe(1);
    expect(backlogBoost(BACKLOG_FROM)).toBe(1);
    expect(backlogBoost(BACKLOG_FULL)).toBeCloseTo(BACKLOG_MAX_BOOST, 5);
    expect(backlogBoost(BACKLOG_FULL * 10)).toBeCloseTo(BACKLOG_MAX_BOOST, 5);
    const mid = backlogBoost((BACKLOG_FROM + BACKLOG_FULL) / 2);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(BACKLOG_MAX_BOOST);
    expect(backlogBoost(Number.NaN)).toBe(1);
  });
  it("multiplies his rate and never passes the ceiling", () => {
    expect(effectiveRate(1.25, 0)).toBe(1.25);
    expect(effectiveRate(2, BACKLOG_FULL)).toBe(RATE_CEILING);
  });
});

describe("backlogSkip", () => {
  const line = (id: string, n: number) => ({ id, text: "x".repeat(n) });
  it("nothing under the limit", () => {
    expect(backlogSkip([line("a", 100), line("b", 100)], new Set(["b"]))).toEqual([]);
  });
  it("past the limit: every older line but the kept ones, once each, in order", () => {
    const q = [
      line("now", 50),
      line("a", BACKLOG_SKIP),
      line("a", 10),
      line("b", 10),
      line("new", 10),
    ];
    expect(backlogSkip(q, new Set(["now", "new"]))).toEqual(["a", "b"]);
  });
  it("lines without an id are never skipped", () => {
    expect(backlogSkip([{ text: "x".repeat(BACKLOG_SKIP + 1) }], new Set())).toEqual([]);
  });
});
