/**
 * The full-screen Gantt's finished bars: estimate vs actual (gantt-view.ts),
 * the done history turned into bars, and the live source asking the hub for
 * it (lib/progress-tree.ts history).
 */
import { describe, expect, it } from "bun:test";
import { estimateVsActual } from "@/lib/estimate";
import { liveTreeSource } from "@/lib/progress-tree";
import { compactTime } from "@lianki/debug-chat/eta";
import {
  GANTT_HISTORY_DAYS,
  doneVsEstimate,
  doneVsLabel,
  historyTasks,
} from "@lianki/debug-chat/gantt-view";

const M = 60_000;
const NOW = 1_800_000_000_000;

describe("doneVsEstimate", () => {
  it("open tasks have none", () => {
    expect(doneVsEstimate({ start: 0, at: 10 })).toBeNull();
    expect(doneVsEstimate({ start: 0, at: 10, done: true })).toBeNull();
  });
  it("the first plan's length vs start → done", () => {
    const v = doneVsEstimate({
      start: 0,
      at: 50 * M,
      plan: { start: 0, at: 30 * M },
      done: true,
      doneAt: 45 * M,
    });
    expect(v).toEqual({ estimateMs: 30 * M, actualMs: 45 * M, ratio: 1.5 });
  });
  it("no plan: start → at is the estimate; agrees with lib/estimate", () => {
    const v = doneVsEstimate({ start: 10, at: 40, done: true, doneAt: 70 });
    expect(v).toEqual(estimateVsActual({ created: 0, startedAt: 10, endedAt: 70, estimateMs: 30 }));
  });
  it("labels: estimate→actual, over past 10%", () => {
    expect(doneVsLabel({ estimateMs: 30 * M, actualMs: 45 * M, ratio: 1.5 }, compactTime)).toEqual({
      text: "30M→45M",
      over: true,
    });
    expect(
      doneVsLabel({ estimateMs: 30 * M, actualMs: 32 * M, ratio: 32 / 30 }, compactTime).over,
    ).toBe(false);
    expect(doneVsLabel({ actualMs: 90 * M }, compactTime)).toEqual({ text: "1.5H", over: false });
  });
});

describe("historyTasks", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    id: "/a",
    title: "A: one",
    created: NOW - 100 * M,
    startedAt: NOW - 90 * M,
    endedAt: NOW - 40 * M,
    estimateMs: 30 * M,
    ...over,
  });
  it("a done bar from start to end, its estimate as the plan", () => {
    expect(historyTasks([rec()], new Set(), NOW)).toEqual([
      {
        id: "/a",
        title: "A: one",
        start: NOW - 90 * M,
        at: NOW - 60 * M,
        plan: { start: NOW - 90 * M, at: NOW - 60 * M },
        done: true,
        doneAt: NOW - 40 * M,
      },
    ]);
  });
  it("skips live ids and old ones; no estimate: no plan, at = end", () => {
    const old = rec({ id: "/old", endedAt: NOW - (GANTT_HISTORY_DAYS + 1) * 24 * 60 * M });
    const got = historyTasks(
      [rec({ id: "/live" }), old, rec({ id: "/b", estimateMs: undefined, startedAt: undefined })],
      new Set(["/live"]),
      NOW,
    );
    expect(got.map((t) => t.id)).toEqual(["/b"]);
    expect(got[0]).toMatchObject({ start: NOW - 100 * M, at: NOW - 40 * M });
    expect(got[0]!.plan).toBeUndefined();
    expect(doneVsEstimate(got[0]!)).toEqual({ actualMs: 60 * M });
  });
});

class FakeSock {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
}

describe("liveTreeSource.history", () => {
  it("asks on an open socket; the answer goes to the caller, not the tree", async () => {
    const socks: FakeSock[] = [];
    const src = liveTreeSource({
      base: () => "## A\n",
      url: "wss://h/p",
      socket: () => {
        const s = new FakeSock();
        socks.push(s);
        return s;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      onWake: () => () => {},
    });
    const got: unknown[][] = [];
    expect(src.history(5, (items) => got.push(items))).toBe(false);
    let updates = 0;
    const off = src.subscribe(() => updates++);
    await new Promise((r) => setTimeout(r, 0));
    const s = socks[0]!;
    s.onopen?.({});
    expect(src.history(5, (items) => got.push(items))).toBe(true);
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ type: "history", limit: 5 });
    const before = updates;
    const item = { id: "/a", title: "A", agent: "x", kind: "task", created: 1, endedAt: 2 };
    s.onmessage?.({ data: JSON.stringify({ type: "history", items: [item], total: 1 }) });
    expect(got).toEqual([[item]]);
    expect(updates).toBe(before);
    off();
  });
});
