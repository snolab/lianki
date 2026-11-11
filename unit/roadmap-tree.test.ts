/**
 * /dev/roadmap from the state tree (lib/roadmap-tree.ts): open nodes by
 * section, the done history, grouped by top-level path; and the socket that
 * feeds it, asking the hub for the history on open.
 */
import { describe, expect, it } from "bun:test";
import type { ProgressEntry, ProgressHistory } from "@/lib/progress";
import { GIVE_UP, type Sock } from "@/lib/progress-tree";
import {
  ROADMAP_HISTORY_LIMIT,
  type RoadmapState,
  roadmapSections,
  roadmapSource,
  sectionCount,
  topOf,
} from "@/lib/roadmap-tree";

const node = (id: string, over: Partial<ProgressEntry> = {}): ProgressEntry => ({
  id,
  assignee: { type: "agent", name: "w" },
  task: `${id}: t`,
  status: "doing",
  kind: "task",
  creator: "w",
  by: "w",
  rev: 1,
  created: 1,
  at: 10,
  ...over,
});
const hist = (
  id: string,
  endedAt: number,
  over: Partial<ProgressHistory> = {},
): ProgressHistory => ({
  id,
  title: `${id} done`,
  agent: "w",
  kind: "task",
  created: 0,
  endedAt,
  ...over,
});

describe("roadmapSections", () => {
  it("sorts open nodes into sections and groups them by top-level path", () => {
    const rows = [
      node("/read/a", { etaAt: 500, at: 20, pr: 3, link: "https://x.test" }),
      node("/read/b", { at: 30 }),
      node("/read/c", { etaAt: 400, at: 5 }),
      node("/words/w", { status: "waiting-owner", needs: "say yes", at: 40 }),
      node("/words/d", { kind: "decision", status: "waiting" }),
      node("/box/r", { status: "review" }),
      node("/box/q", { status: "waiting" }),
      node("/box/ref", { status: "waiting" }),
      node("/@owner/ask", { status: "waiting-owner", ref: "/box/ref" }),
      node("/read", { kind: "group" }),
      node("/@owner", { kind: "person" }),
      node("slug-child", { parent: "/words/w" }),
      node("orphan", {}),
    ];
    const b = roadmapSections(rows, []);
    expect(b.doing.map((g) => g.top)).toEqual(["/read", "/words", "/"]);
    expect(b.doing[0]!.items.map((i) => i.id)).toEqual(["/read/c", "/read/a", "/read/b"]);
    expect(b.doing[0]!.items[1]).toEqual({
      id: "/read/a",
      title: "/read/a: t",
      prs: [3],
      at: 20,
      etaAt: 500,
      link: "https://x.test",
    });
    expect(b.waiting.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual([
      "/box/ref",
      "/words/d",
      "/words/w",
    ]);
    expect(b.waiting.flatMap((g) => g.items).find((i) => i.id === "/words/w")?.needs).toBe(
      "say yes",
    );
    expect(b.queued.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(["/box/q", "/box/r"]);
    expect(sectionCount(b.doing)).toBe(5);
    expect(sectionCount(b.done)).toBe(0);
  });
  it("lists the done history and the tree's done nodes; open beats done", () => {
    const history = [
      hist("/read/old", 5, { prs: [1], link: "https://y.test" }),
      hist("/read/again", 6),
      hist("/words/w", 7),
      hist("/@owner/q", 8),
      hist("/g", 9, { kind: "group" }),
      hist("kid", 4, { parent: "/box/x" }),
    ];
    const rows = [
      node("/read/again", { status: "doing" }),
      node("/words/w", { status: "done", endedAt: 50, task: "W new", pr: 9 }),
    ];
    const b = roadmapSections(rows, history);
    expect(b.done.map((g) => g.top)).toEqual(["/words", "/read", "/box"]);
    expect(b.done[0]!.items).toEqual([{ id: "/words/w", title: "W new", prs: [9], at: 50 }]);
    expect(b.done[1]!.items).toEqual([
      { id: "/read/old", title: "/read/old done", prs: [1], at: 5, link: "https://y.test" },
    ]);
    expect(b.doing[0]!.items[0]!.id).toBe("/read/again");
  });
  it("topOf walks a slug's parents, and gives up on a loop", () => {
    const parents = new Map<string, string | undefined>([
      ["a", "b"],
      ["b", "/x/y"],
      ["l1", "l2"],
      ["l2", "l1"],
    ]);
    expect(topOf("a", parents)).toBe("/x");
    expect(topOf("/top", parents)).toBe("/top");
    expect(topOf("l1", parents)).toBe("/");
    expect(topOf("nope", parents)).toBe("/");
  });
});

class FakeSock implements Sock {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  throwOnSend = false;
  send(d: string) {
    if (this.throwOnSend) throw new Error("closed");
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function harness() {
  const socks: FakeSock[] = [];
  const timers: { fn: () => void; ms: number; cancelled?: boolean }[] = [];
  let wakeFn: (() => void) | null = null;
  let unwoke = false;
  const states: RoadmapState[] = [];
  const stop = roadmapSource(
    {
      url: "wss://x/api/version/progress",
      socket: () => {
        const s = new FakeSock();
        socks.push(s);
        return s;
      },
      setTimeout: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout: (t) => void ((t as { cancelled?: boolean }).cancelled = true),
      onWake: (fn) => {
        wakeFn = fn;
        return () => void (unwoke = true);
      },
    },
    (s) => states.push(s),
  );
  return {
    socks,
    timers,
    states,
    stop,
    wake: () => wakeFn?.(),
    unwoke: () => unwoke,
    last: () => states.at(-1)!,
  };
}

describe("roadmapSource", () => {
  it("asks for the history on open, folds the tree and done events into it", () => {
    const h = harness();
    const s = h.socks[0]!;
    s.onopen?.({});
    expect(JSON.parse(s.sent[0]!)).toEqual({ type: "history", limit: ROADMAP_HISTORY_LIMIT });
    s.msg({ type: "snapshot", entries: [node("/a/x")], log: [] });
    expect(h.last()).toMatchObject({ live: true, loaded: false });
    expect(h.last().rows.map((r) => r.id)).toEqual(["/a/x"]);
    s.msg({ type: "history", items: [hist("/a/x", 1), hist("/a/y", 2)], total: 2 });
    expect(h.last()).toMatchObject({ loaded: true });
    s.msg({ type: "progress", ...node("/a/x", { status: "done", at: 20, endedAt: 20 }) });
    expect(h.last().history.map((x) => [x.id, x.endedAt])).toEqual([
      ["/a/x", 20],
      ["/a/y", 2],
    ]);
    // A group going done is not history; junk is ignored.
    const n = h.states.length;
    s.msg({ type: "progress", ...node("/a", { status: "done", kind: "group" }) });
    expect(h.last().history).toHaveLength(2);
    s.onmessage?.({ data: "{" });
    expect(h.states.length).toBe(n + 1);
    h.stop();
    expect(s.closed).toBe(true);
    expect(h.unwoke()).toBe(true);
    s.msg({ type: "snapshot", entries: [], log: [] });
    expect(h.states.length).toBe(n + 1);
  });
  it("reconnects with backoff, gives up, and starts again on a wake", () => {
    const h = harness();
    const s = h.socks[0]!;
    s.throwOnSend = true;
    s.onopen?.({});
    s.msg({ type: "snapshot", entries: [], log: [] });
    s.onclose?.({});
    expect(h.last().live).toBe(false);
    expect(h.timers[0]!.ms).toBe(1000);
    s.onclose?.({}); // a stale close: nothing
    expect(h.timers).toHaveLength(1);
    h.wake(); // no socket now: connects at once, cancelling the timer
    expect(h.timers[0]!.cancelled).toBe(true);
    expect(h.socks).toHaveLength(2);
    h.wake(); // a socket is open: nothing
    expect(h.socks).toHaveLength(2);
    for (let i = 0; i <= GIVE_UP; i++) {
      const cur = h.socks.at(-1)!;
      cur.onerror?.({});
      expect(cur.closed).toBe(true);
      h.timers.at(-1)?.fn();
    }
    expect(h.timers.at(-1)!.ms).toBe(60_000);
    const before = h.socks.length;
    h.socks.at(-1)!.onclose?.({});
    expect(h.socks.length).toBe(before);
    h.stop();
    h.timers.at(-1)!.fn();
    expect(h.socks.length).toBe(before);
  });
  it("defaults to the browser's WebSocket and timers", () => {
    const g = globalThis as unknown as { WebSocket: unknown };
    const was = g.WebSocket;
    const made: FakeSock[] = [];
    g.WebSocket = class extends FakeSock {
      constructor(public url: string) {
        super();
        made.push(this);
      }
    };
    try {
      const stop = roadmapSource({ url: "wss://x", onWake: () => () => {} }, () => {});
      expect(made).toHaveLength(1);
      made[0]!.onclose?.({}); // schedules a real timer…
      stop(); // …which stop clears
      expect(made).toHaveLength(1);
    } finally {
      g.WebSocket = was;
    }
  });
});
