import { describe, expect, it } from "bun:test";
import { parseTreeDoc } from "@lianki/debug-chat/state-tree";
import type { TreeNode } from "@lianki/debug-chat/state-tree";
import {
  GIVE_UP,
  browserWake,
  liveTreeSource,
  overlayProgress,
  progressSocketUrl,
} from "@/lib/progress-tree";
import {
  OWNER_NODE,
  type ProgressEntry,
  autoNode,
  mergeProgress,
  parseProgressReport,
  progressEvent,
} from "@/lib/progress";

const MD = `# T

## /words
- [x] Audio prefetch (#291)
- [ ] Swipe @main-lane
  - [ ] Native fix

## @owner — your to-do
- [ ] (!) Something @owner
`;

const entry = (b: Record<string, unknown>, at = 1): ProgressEntry =>
  mergeProgress(
    undefined,
    parseProgressReport({ task: "t", status: "doing", agent: "a", ...b }) as never,
    at,
  );
const find = (nodes: TreeNode[], ...titles: string[]): TreeNode | undefined => {
  let n: TreeNode | undefined;
  let list = nodes;
  for (const t of titles) {
    n = list.find((c) => c.title === t);
    if (!n) return undefined;
    list = n.children;
  }
  return n;
};

describe("overlayProgress", () => {
  it("updates outline nodes by path and adds what is missing", () => {
    const base = parseTreeDoc(MD, { repo: "o/r" });
    const out = overlayProgress(
      base,
      [
        entry({ id: "/words/swipe", pct: 40, eta: "15m", pr: 310, note: "halfway" }),
        entry({ id: "/words/swipe/native", status: "done" }),
        entry({ id: "/words/new/deep", task: "Deep", kind: "feedback", needs: "look" }),
        entry({
          id: "/_infra/x",
          task: "X",
          kind: "decision",
          link: "https://e.x/1",
          action: "run #5",
        }),
        autoNode("/_infra", "a", 1),
        autoNode(OWNER_NODE, "a", 1),
        entry({ id: `${OWNER_NODE}/x`, kind: "approval", ref: "/words/swipe", task: "OK it" }),
        entry({ id: "loose-one", task: "Loose" }),
        entry({ id: "loose-two", task: "Loose" }),
      ],
      { repo: "o/r" },
    );
    expect(base.children[0]!.children[1]!.status).toBe("open"); // input unchanged
    const swipe = find(out.children, "/words", "Swipe")!;
    expect(swipe).toMatchObject({
      status: "doing",
      needsOwner: true,
      assignee: { type: "agent", name: "a" },
      note: "40% · ETA 15m · halfway",
    });
    expect(swipe.links.map((l) => l.url)).toContain("https://github.com/o/r/pull/310");
    expect(find(out.children, "/words", "Swipe", "Native fix")!.done).toBe(true);
    expect(find(out.children, "/words", "new", "Deep")).toMatchObject({ needsOwner: true });
    const x = find(out.children, "/_infra", "X")!;
    expect(x.action).toBe("run #5");
    expect(x.links.map((l) => l.url)).toEqual(["https://e.x/1", "https://github.com/o/r/pull/5"]);
    expect(find(out.children, "@owner — your to-do", "OK it")).toBeDefined();
    expect(find(out.children, "Live")!.children).toHaveLength(1);
    // A done node no longer waits on the owner.
    const done = overlayProgress(parseTreeDoc("## /a\n- [ ] (!) b"), [
      entry({ id: "/a/b", status: "done" }),
    ]);
    expect(find(done.children, "/a", "(!) b") ?? find(done.children, "/a", "b")).toMatchObject({
      done: true,
    });
    expect(find(done.children, "/a", "b")!.needsOwner).toBeUndefined();
    // A note joins the outline's own.
    const noted = overlayProgress(parseTreeDoc("## /a\n- [ ] b\n  own note"), [
      entry({ id: "/a/b", pct: 5 }),
    ]);
    expect(find(noted.children, "/a", "b")!.note).toBe("5%\nown note");
  });

  it("names the socket after the page's host", () => {
    expect(progressSocketUrl({ protocol: "https:", host: "h" })).toBe(
      "wss://h/api/version/progress",
    );
    expect(progressSocketUrl({ protocol: "http:", host: "h:1" })).toBe(
      "ws://h:1/api/version/progress",
    );
  });
});

class FakeSock {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
}

describe("liveTreeSource", () => {
  const make = (base: () => string | Promise<string> = () => MD) => {
    const socks: FakeSock[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    let wake: (() => void) | null = null;
    const updates: { nodes: TreeNode[]; live?: boolean }[] = [];
    const errors: unknown[] = [];
    const src = liveTreeSource({
      base,
      url: "wss://h/p",
      socket: () => {
        const s = new FakeSock();
        socks.push(s);
        return s;
      },
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => {},
      onWake: (fn) => {
        wake = fn;
        return () => (wake = null);
      },
    }) as {
      subscribe: (
        u: (v: unknown, m?: { live?: boolean }) => void,
        e?: (x: unknown) => void,
      ) => () => void;
    };
    const off = src.subscribe(
      (v, m) => updates.push({ nodes: v as TreeNode[], live: m?.live }),
      (e) => errors.push(e),
    );
    return { socks, timers, updates, errors, off, wake: () => wake?.() };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("pushes the outline, then the overlay on every message", async () => {
    const h = make();
    await flush();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.live).toBe(false);
    const s = h.socks[0]!;
    s.onopen?.({});
    s.onmessage?.({ data: "junk" });
    expect(h.updates).toHaveLength(1);
    const e = entry({ id: "/words/swipe", pct: 10 });
    s.onmessage?.({ data: JSON.stringify({ type: "snapshot", entries: [e], log: [] }) });
    s.onmessage?.({ data: JSON.stringify(progressEvent({ ...e, pct: 20, at: 2 })) });
    expect(h.updates.at(-1)!.live).toBe(true);
    expect(find(h.updates.at(-1)!.nodes, "/words", "Swipe")!.note).toBe("20%");
    // Lost: not live any more, one reconnect scheduled with backoff.
    s.onclose?.({});
    expect(h.updates.at(-1)!.live).toBe(false);
    expect(h.timers.map((t) => t.ms)).toEqual([1000]);
    s.onclose?.({}); // a second close of the same socket is nothing
    h.timers[0]!.fn();
    expect(h.socks).toHaveLength(2);
    h.wake(); // already connected: nothing
    expect(h.socks).toHaveLength(2);
    h.socks[1]!.onerror?.({});
    expect(h.socks[1]!.closed).toBe(true);
    expect(h.timers.at(-1)!.ms).toBe(2000);
    h.off();
    h.timers.at(-1)!.fn();
    expect(h.socks).toHaveLength(2);
  });

  it("gives up after GIVE_UP failures until a wake, and reports a base that fails", async () => {
    const h = make(() => Promise.reject(new Error("HTTP 404")));
    await flush();
    expect(String(h.errors[0])).toContain("404");
    for (let i = 0; i <= GIVE_UP; i++) {
      h.socks.at(-1)!.onclose?.({});
      if (i < GIVE_UP) h.timers.at(-1)!.fn();
    }
    expect(h.timers).toHaveLength(GIVE_UP);
    expect(h.timers.at(-1)!.ms).toBe(60_000);
    const n = h.socks.length;
    h.wake();
    expect(h.socks).toHaveLength(n + 1);
    h.off();
    h.socks.at(-1)!.onclose?.({});
  });
});

describe("browserWake", () => {
  it("wakes on online and on a visible tab, and unhooks", () => {
    const on = new Map<string, () => void>();
    const target = {
      addEventListener: (k: string, f: () => void) => on.set(k, f),
      removeEventListener: (k: string) => on.delete(k),
    };
    const g = globalThis as Record<string, unknown>;
    const saved = [g.window, g.document];
    g.window = target;
    g.document = { ...target, visibilityState: "visible" };
    let n = 0;
    const off = browserWake(() => n++);
    on.get("online")!();
    on.get("visibilitychange")!();
    expect(n).toBe(2);
    off();
    expect(on.size).toBe(0);
    [g.window, g.document] = saved;
  });
});
