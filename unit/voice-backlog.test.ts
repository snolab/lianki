// The read-aloud backlog (owner, 2026-11-14): a long queue reads faster, and a
// very long one skips older lines to read the newest (packages/debug-chat/src/voice.ts).
import { describe, expect, it } from "bun:test";
import {
  type UtterLike,
  createVoice,
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
    expect(backlogSkip([line("a", BACKLOG_SKIP)], new Set())).toEqual([]);
    expect(backlogSkip([line("a", BACKLOG_SKIP + 1)], new Set())).toEqual(["a"]);
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

describe("voice backlog drop notifications", () => {
  function harness() {
    const spoken: UtterLike[] = [];
    const events: (string[] | number)[] = [];
    let cancels = 0;
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => void cancels++ }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    v.setMic(true);
    v.onDrop((ids) => events.push(ids));
    v.subscribe((state) => events.push(state.queued));
    return { v, spoken, events, cancels: () => cancels, end: () => spoken.at(-1)?.onend?.() };
  }

  it("reports only removed older ids once, before publishing the trimmed queue, keeping the active and newest lines", () => {
    const h = harness();
    h.v.reply("Active first. Active second.", { id: "active" });
    h.v.reply("a".repeat(700), { id: "old-a" });
    h.v.reply("b".repeat(700), { id: "old-b" });
    expect(h.events.filter(Array.isArray)).toEqual([]);
    const active = h.spoken[0];
    h.events.length = 0;
    h.v.reply("Newest. " + "c".repeat(200), { id: "new" });
    expect(h.events[0]).toEqual(["old-a", "old-b"]);
    expect(h.events.filter(Array.isArray)).toEqual([["old-a", "old-b"]]);
    expect(h.events[1]).toBe(h.v.state().queued);
    expect(h.spoken[0]).toBe(active);
    expect(h.cancels()).toBe(0);
    // Both sentences of the active line survive, followed by the newest line;
    // no discarded chunk is ever spoken.
    while (h.v.state().queued) h.end();
    expect(h.spoken.map((u) => u.text)).toEqual([
      "Active first.",
      "Active second.",
      "Newest.",
      "c".repeat(200),
    ]);
    expect(h.events.filter(Array.isArray)).toEqual([["old-a", "old-b"]]);
  });

  it("does not notify when an oversized queue contains only kept ids or anonymous entries", () => {
    const h = harness();
    h.v.reply("Active.", { id: "active" });
    h.v.reply("x".repeat(BACKLOG_SKIP + 1));
    expect(h.events.filter(Array.isArray)).toEqual([]);
    h.v.reply("y".repeat(BACKLOG_SKIP + 1), { id: "new" });
    expect(h.events.filter(Array.isArray)).toEqual([]);
    expect(h.cancels()).toBe(0);
    expect(h.v.state().queued).toBeGreaterThan(2);
  });
});
