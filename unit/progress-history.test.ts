/**
 * The hub's durable done history (docs/state-tree.md, "Done history"): a done
 * node leaves a record that outlives the live tree's 24-hour prune; a node
 * keeps every PR it named; GET /history and a reader's {type:"history"}
 * serve it; the stats log is copied in once.
 */
import { describe, expect, it } from "bun:test";
import { HISTORY_MIGRATED, PROGRESS_OWNER_HEADER, ProgressHub } from "@/workers/push/src/progress";
import type { Socket, Storage } from "@/workers/push/src/debug";
import {
  PROGRESS_DONE_TTL_MS,
  PROGRESS_HISTORY_SEND_DEFAULT,
  PROGRESS_HISTORY_SEND_MAX,
  PROGRESS_PRS_MAX,
  type ProgressEntry,
  type ProgressHistory,
  historyFromDone,
  mergePrs,
  mergeProgress,
  newestHistory,
  parseHistoryMessage,
  parseProgressMessage,
  parseProgressReport,
  progressHistory,
  prsOf,
} from "@/lib/progress";
import { formatHistory, parseProgressArgs } from "@/scripts/dev/progress-args";

const ROOT = "root-secret";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  constructor(private att: unknown = null) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  serializeAttachment(v: unknown) {
    this.att = v;
  }
  deserializeAttachment() {
    return this.att;
  }
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

function setup(boxSaid = "live") {
  let t = 1_700_000_000_000;
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
    delete: async (k: string) => store.delete(k),
    list: async <T>({ prefix }: { prefix: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  } as unknown as Storage;
  const sockets: FakeSocket[] = [];
  const hub = new ProgressHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { PROGRESS_TOKEN: ROOT, SESSIONS: { boxChat: async () => boxSaid } },
    () => t,
  );
  const call = async (path: string, body?: unknown) => {
    const res = await hub.fetch(
      new Request(`https://lianki.com/api/version/progress${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${ROOT}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const write = (body: Record<string, unknown>) =>
    call("", { agent: "w", status: "doing", task: "T: t", ...body });
  return { hub, store, sockets, call, write, tick: (ms: number) => (t += ms), now: () => t };
}

describe("PRs on a node", () => {
  it("parses prs and keeps every PR a node named", () => {
    const r = parseProgressReport({ agent: "w", task: "T: t", status: "doing", prs: [3, 3, 4] });
    expect(r).toMatchObject({ prs: [3, 4] });
    for (const prs of [[0], ["1"], "1", Array(PROGRESS_PRS_MAX + 1).fill(1)])
      expect(parseProgressReport({ agent: "w", task: "T", status: "doing", prs })).toBeInstanceOf(
        Error,
      );
    expect(
      parseProgressReport({ agent: "w", task: "T: t", status: "doing", prs: [] }),
    ).not.toHaveProperty("prs");
    const base = { id: "/a", assignee: { type: "agent", name: "w" }, task: "T", status: "doing" };
    const one = mergeProgress(undefined, { ...base, pr: 5 } as never, 1);
    expect(one.prs).toEqual([5]);
    const two = mergeProgress(one, { ...base, prs: [6, 5] } as never, 2);
    expect(two).toMatchObject({ pr: 5, prs: [5, 6] });
    // A node from before `prs` existed: its `pr` is kept.
    const { prs: _p, ...old } = one;
    expect(mergeProgress(old, { ...base, pr: 7 } as never, 3).prs).toEqual([5, 7]);
    expect(mergeProgress(undefined, base as never, 1)).not.toHaveProperty("prs");
  });
  it("mergePrs keeps the newest; prsOf reads the title too", () => {
    const many = Array.from({ length: PROGRESS_PRS_MAX + 3 }, (_, i) => i + 1);
    expect(mergePrs(many, [])).toHaveLength(PROGRESS_PRS_MAX);
    expect(mergePrs([1], [2, 1])).toEqual([1, 2]);
    expect(prsOf({ task: "Gate: speed (#701, #704) a&#1;", prs: [700] })).toEqual([700, 701, 704]);
    expect(prsOf({ task: "#9 first", pr: 8 })).toEqual([8, 9]);
    expect(prsOf({ task: "none" })).toEqual([]);
  });
});

describe("history records", () => {
  const entry: ProgressEntry = {
    id: "/x/a",
    parent: "/x",
    assignee: { type: "agent", name: "w" },
    task: "A: a",
    status: "done",
    kind: "task",
    creator: "w",
    by: "w",
    rev: 3,
    created: 10,
    at: 50,
    startedAt: 20,
    endedAt: 40,
    estimateMs: 5,
    prs: [1],
    link: "https://x.test",
  };
  it("a done node → its record", () => {
    expect(progressHistory(entry)).toEqual({
      id: "/x/a",
      parent: "/x",
      title: "A: a",
      agent: "w",
      kind: "task",
      created: 10,
      startedAt: 20,
      endedAt: 40,
      estimateMs: 5,
      prs: [1],
      link: "https://x.test",
    });
    const bare = progressHistory({
      ...entry,
      creator: "_auto",
      by: "z",
      parent: undefined,
      endedAt: undefined,
      prs: undefined,
      link: undefined,
      startedAt: undefined,
      estimateMs: undefined,
    });
    expect(bare).toEqual({
      id: "/x/a",
      title: "A: a",
      agent: "z",
      kind: "task",
      created: 10,
      endedAt: 50,
    });
  });
  it("a stats record → a history record", () => {
    const d = { at: 100, agent: "w", id: "/x/b", title: "B", actualMs: 30, revisions: 0 };
    expect(historyFromDone({ ...d, estimateMs: 9 })).toEqual({
      id: "/x/b",
      title: "B",
      agent: "w",
      kind: "task",
      parent: "/x",
      created: 70,
      endedAt: 100,
      estimateMs: 9,
    });
    expect(historyFromDone({ ...d, id: "slug" })).not.toHaveProperty("parent");
    expect(historyFromDone({ ...d, id: "/top" })).not.toHaveProperty("parent");
  });
  it("newestHistory sorts and caps", () => {
    const h = (endedAt: number) => ({ endedAt }) as ProgressHistory;
    expect(newestHistory([h(1), h(3), h(2)], 2).map((x) => x.endedAt)).toEqual([3, 2]);
    const many = Array.from({ length: PROGRESS_HISTORY_SEND_MAX + 5 }, (_, i) => h(i));
    expect(newestHistory(many, 1e9)).toHaveLength(PROGRESS_HISTORY_SEND_MAX);
    expect(newestHistory(many)).toHaveLength(PROGRESS_HISTORY_SEND_DEFAULT);
    expect(newestHistory(many, 0)).toHaveLength(1);
  });
  it("parseHistoryMessage takes only history answers", () => {
    const ok: ProgressHistory = {
      id: "a",
      title: "A",
      agent: "w",
      kind: "task",
      created: 0,
      endedAt: 1,
      prs: [1],
    };
    expect(
      parseHistoryMessage(
        JSON.stringify({ type: "history", items: [ok, { id: "b" }, null], total: 9 }),
      ),
    ).toEqual({ type: "history", items: [ok], total: 9 });
    expect(parseHistoryMessage(JSON.stringify({ type: "history", items: [ok] }))?.total).toBe(1);
    expect(
      parseHistoryMessage(JSON.stringify({ type: "history", items: [{ ...ok, prs: ["1"] }] }))
        ?.items,
    ).toEqual([]);
    for (const raw of [
      "{",
      3,
      JSON.stringify(null),
      JSON.stringify({ type: "snapshot", entries: [] }),
    ])
      expect(parseHistoryMessage(raw)).toBeNull();
    // The tree's own parser ignores it: ETA bar and Gantt see nothing new.
    expect(parseProgressMessage(JSON.stringify({ type: "history", items: [ok] }))).toBeNull();
  });
});

describe("the hub's done history", () => {
  it("records a done node, keeps it past the 24-hour prune, serves it at /history", async () => {
    const h = setup();
    await h.write({ id: "/x/a", task: "A: a", pr: 11 });
    await h.write({ id: "/x/a", task: "A: a", status: "done", pr: 12 });
    await h.write({ id: "/x/g", task: "G", status: "done", kind: "group" });
    h.tick(PROGRESS_DONE_TTL_MS + 1);
    await h.hub.alarm();
    expect(h.store.has("e:/x/a")).toBe(false);
    const got = await h.call("/history");
    expect(got.body).toMatchObject({ type: "history", total: 1 });
    expect(got.body.items).toMatchObject([{ id: "/x/a", prs: [11, 12], agent: "w" }]);
    // Done again later: one record, the new end.
    await h.write({ id: "/x/a", task: "A: again", status: "doing" });
    await h.write({ id: "/x/a", task: "A: again", status: "done" });
    const again = (await h.call("/history?limit=1")).body;
    expect(again.items).toMatchObject([{ title: "A: again", endedAt: h.now() }]);
    expect(again.total).toBe(1);
  });
  it("copies the stats log and done live nodes in once", async () => {
    const h = setup();
    h.store.set("d:000000000000001:000000", {
      at: 1,
      agent: "old",
      id: "/old/a",
      title: "Old",
      actualMs: 1,
      revisions: 0,
    });
    h.store.set("d:000000000000002:000001", {
      at: 2,
      agent: "w",
      id: "/x/live",
      title: "Live (stats)",
      actualMs: 1,
      revisions: 0,
    });
    h.store.set("e:/x/live", {
      id: "/x/live",
      parent: "/x",
      assignee: { type: "agent", name: "w" },
      task: "Live",
      status: "done",
      kind: "task",
      creator: "w",
      by: "w",
      rev: 1,
      created: 1,
      at: 2,
      pr: 40,
    });
    h.store.set("e:/x/open", {
      ...(h.store.get("e:/x/live") as object),
      id: "/x/open",
      status: "doing",
    });
    h.store.set("h:/kept", {
      id: "/kept",
      title: "K",
      agent: "w",
      kind: "task",
      created: 0,
      endedAt: 0,
    });
    const got = (await h.call("/history")).body;
    expect(got.items.map((x: ProgressHistory) => x.id).sort()).toEqual([
      "/kept",
      "/old/a",
      "/x/live",
    ]);
    expect(got.items.find((x: ProgressHistory) => x.id === "/x/live")).toMatchObject({
      title: "Live",
      prs: [40],
    });
    expect(h.store.get(HISTORY_MIGRATED)).toBe(h.now());
    // Once only: a record deleted afterwards does not come back.
    h.store.delete("h:/old/a");
    expect((await h.call("/history")).body.total).toBe(2);
  });
  it("a reader asks on its socket and only it is answered; the snapshot carries none", async () => {
    const h = setup();
    await h.write({ id: "/x/a", task: "A", status: "done" });
    const res = await h.hub.fetch(
      new Request("https://lianki.com/api/version/progress", {
        headers: { upgrade: "websocket", [PROGRESS_OWNER_HEADER]: "1" },
      }),
    );
    expect(res.status).toBe(101);
    const page = h.sockets.at(-1)!;
    const other = new FakeSocket();
    h.sockets.push(other);
    expect(page.sent[0]).not.toHaveProperty("history");
    await h.hub.webSocketMessage(page, JSON.stringify({ type: "history", limit: 5 }));
    expect(page.sent.at(-1)).toMatchObject({ type: "history", total: 1, items: [{ id: "/x/a" }] });
    expect(other.sent).toEqual([]);
    await h.hub.webSocketMessage(
      page,
      new TextEncoder().encode(JSON.stringify({ type: "history" })).buffer,
    );
    expect(page.sent.at(-1)).toMatchObject({ type: "history" });
  });
  it("the owner's box may read it while its box may chat", async () => {
    const live = setup("live");
    await live.write({ id: "/x/a", task: "A", status: "done" });
    const box = new FakeSocket({ box: "c1", checked: 0 });
    await live.hub.webSocketMessage(box, JSON.stringify({ type: "history" }));
    expect(box.sent.at(-1)).toMatchObject({ type: "history", total: 1 });
    await live.hub.webSocketMessage(box, JSON.stringify({ type: "resolve", id: "/x/a" }));
    expect(box.sent).toHaveLength(1);
    const gone = setup("gone");
    const late = new FakeSocket({ box: "c1", checked: 0 });
    await gone.hub.webSocketMessage(late, JSON.stringify({ type: "history" }));
    expect(late.sent).toEqual([]);
  });
});

describe("back-dated done nodes (moving old work in)", () => {
  it("parses endedAt only for a done node", () => {
    const base = { agent: "w", task: "T: t", status: "done" };
    expect(parseProgressReport({ ...base, endedAt: 5 })).toMatchObject({ endedAt: 5 });
    expect(parseProgressReport({ ...base, endedAt: "5" })).toBeInstanceOf(Error);
    expect(parseProgressReport({ ...base, endedAt: 0 })).toBeInstanceOf(Error);
    expect(parseProgressReport({ ...base, status: "doing", endedAt: 5 })).toBeInstanceOf(Error);
    expect(
      parseProgressArgs([
        "--agent",
        "w",
        "--task",
        "T: t",
        "--done",
        "--ended",
        "2026-11-01T00:00Z",
      ]),
    ).toMatchObject({ report: { endedAt: Date.parse("2026-11-01T00:00Z") } });
    expect(
      parseProgressArgs(["--agent", "w", "--task", "T: t", "--done", "--ended", "x"]),
    ).toBeInstanceOf(Error);
  });
  it("the root back-dates; the history takes the date, the stats log does not", async () => {
    const h = setup();
    await h.write({ id: "/x/old", task: "Old: o", status: "done", endedAt: 1_000, prs: [1, 2] });
    const got = (await h.call("/history")).body.items;
    expect(got).toMatchObject([{ id: "/x/old", endedAt: 1_000, prs: [1, 2] }]);
    expect([...h.store.keys()].some((k) => k.startsWith("d:"))).toBe(false);
    // A later write to the done node (another PR) reaches its record.
    await h.write({ id: "/x/old", task: "Old: o", status: "done", pr: 3 });
    expect((await h.call("/history")).body.items[0]).toMatchObject({
      prs: [1, 2, 3],
      endedAt: 1_000,
    });
  });
  it("a scoped token may not back-date", async () => {
    const h = setup();
    const scoped = (await h.call("/grant", { node: "/x", agent: "w" })).body.token as string;
    const res = await h.hub.fetch(
      new Request("https://lianki.com/api/version/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${scoped}` },
        body: JSON.stringify({ agent: "w", id: "/x", task: "X", status: "done", endedAt: 5 }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("progress.ts history", () => {
  it("parses history, show --all and several PRs", () => {
    expect(parseProgressArgs(["history"])).toEqual({ cmd: "history" });
    expect(
      parseProgressArgs(["history", "--agent", "w", "--since", "2d", "--limit", "9", "--json"]),
    ).toEqual({ cmd: "history", agent: "w", since: 2 * 86_400_000, limit: 9, json: true });
    expect(parseProgressArgs(["history", "--since", "soon"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["show", "--all"])).toEqual({ cmd: "show", all: true });
    expect(parseProgressArgs(["show"])).toEqual({ cmd: "show" });
    const r = parseProgressArgs([
      "--agent",
      "w",
      "--task",
      "T: t",
      "--status",
      "done",
      "--pr",
      "#703, 707",
    ]);
    expect(r).toMatchObject({ cmd: "report", report: { prs: [703, 707] } });
    expect(
      parseProgressArgs(["--agent", "w", "--task", "T: t", "--status", "done", "--pr", "1,x"]),
    ).toBeInstanceOf(Error);
  });
  it("formats the history for a terminal", () => {
    const items = [
      { id: "/a", title: "A", agent: "w", kind: "task", created: 0, endedAt: 1_000, prs: [1, 2] },
      { id: "/b", title: "B", agent: "z", kind: "task", created: 0, endedAt: 0 },
    ] as ProgressHistory[];
    expect(formatHistory(items, { now: 2_000 })).toBe(
      "1970-01-01 09:00 JST  /a  #1 #2  A  (w)\n1970-01-01 09:00 JST  /b  B  (z)",
    );
    expect(formatHistory(items, { agent: "z" })).toContain("/b");
    expect(formatHistory(items, { since: 1_500, now: 2_000 })).not.toContain("/b");
    expect(formatHistory([])).toContain("no done nodes");
  });
});
