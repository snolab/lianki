import { describe, expect, it } from "bun:test";
import { DebugHub, type Storage, type HubTimer, type Socket } from "@/workers/push/src/debug";
import { CHAT_HISTORY, parsePageMessage } from "@/lib/dev-eval";
import { applyEdit, applyWithdrawn, type ChatMessage } from "@/packages/debug-chat/src/wire";
import { parsePresent } from "@/packages/debug-chat/src/presence";

class PageSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  private attachment: unknown;
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

function fixture() {
  const data = new Map<string, unknown>();
  const sockets: Socket[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  let now = 10000;
  const storage: Storage = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key) => data.delete(key),
    list: async <T>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(data.get(k)) as T]));
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  storage.transaction = async (run) => {
    const before = structuredClone(data);
    try {
      return await run(storage);
    } catch (error) {
      data.clear();
      for (const [key, value] of before) data.set(key, value);
      throw error;
    }
  };
  const timer: HubTimer = {
    set: (run, ms) => {
      const x = { run, ms };
      timers.push(x);
      return x;
    },
    clear: () => {},
  };
  const hub = new DebugHub(
    { storage, getWebSockets: () => sockets, acceptWebSocket: (ws) => sockets.push(ws) },
    undefined,
    () => now,
    timer,
  );
  const internal = hub as unknown as {
    post(m: ChatMessage & { thread: string }): Promise<number>;
    nextChatSeq(thread: string): Promise<number>;
    writeLine(key: string | undefined, m: ChatMessage): Promise<number>;
    unmerge(
      ws: { send(s: string): void },
      page: { thread: string; label: string },
      id: string,
    ): Promise<void>;
  };
  const line = (id: string, at = 1, thread = "owner"): ChatMessage & { thread: string } => ({
    id,
    at,
    thread,
    from: "owner",
    label: "page",
    text: id,
  });
  return {
    data,
    storage,
    hub,
    internal,
    line,
    timers,
    sockets,
    tick: (n: number) => {
      now += n;
    },
  };
}
const settle = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

describe("thread version replay and explicit read cursors", () => {
  it("covers nonvisible accepted gaps and bounded ranges, isolated by authenticated thread", async () => {
    const f = fixture();
    await f.internal.post(f.line("a"));
    await f.internal.nextChatSeq("owner");
    await f.internal.post(f.line("b", 2));
    await f.internal.post(f.line("private", 1, "friend"));
    const first = await f.hub.replay("owner", 0, undefined, 2);
    expect(first).toMatchObject({
      thread: "owner",
      afterSeq: 0,
      throughSeq: 2,
      headSeq: 3,
      prunedThroughSeq: 0,
      skipped: [{ from: 2, to: 2 }],
    });
    expect(first.messages.map((m) => [m.id, m.seq])).toEqual([["a", 1]]);
    expect((await f.hub.replay("owner", first.throughSeq)).messages.map((m) => m.id)).toEqual([
      "b",
    ]);
    expect((await f.hub.replay("friend", 0)).messages.map((m) => m.id)).toEqual(["private"]);
    expect((await f.hub.replay("owner", 999)).throughSeq).toBe(3);
  });
  it("moves only the changed line version, recovers edits and keeps logical order", async () => {
    const f = fixture();
    await f.internal.post(f.line("a", 1));
    await f.internal.post(f.line("b", 2));
    const b = structuredClone(f.data.get("msg:000000000002"));
    await f.internal.writeLine("msg:000000000001", { ...f.line("a", 1), text: "edited" });
    expect(f.data.has("msg:000000000001")).toBe(false);
    expect(f.data.get("msg:000000000002")).toEqual(b);
    expect((await f.hub.history()).map((m) => [m.id, m.seq])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect((await f.hub.replay("owner", 2)).messages).toMatchObject([
      { id: "a", seq: 3, text: "edited" },
    ]);
  });
  it("does not report a counter gap while a visible row is still writing", async () => {
    const f = fixture();
    const original = f.storage.put;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    f.storage.put = async (key, value) => {
      if (key.startsWith("msg:")) {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      await original(key, value);
    };
    const posting = f.internal.post(f.line("a"));
    await ready;
    let done = false;
    const reading = f.hub.replay("owner", 0).then((x) => {
      done = true;
      return x;
    });
    await settle();
    expect(done).toBe(false);
    release();
    await posting;
    expect((await reading).messages.map((m) => m.seq)).toEqual([1]);
  });
  it("unmerge allocates restored versions without renumbering a later reply", async () => {
    const f = fixture();
    await f.internal.post({
      ...f.line("a", 1),
      text: "one two",
      parts: [
        { id: "a", text: "one", at: 1 },
        { id: "b", text: "two", at: 2 },
      ],
    });
    await f.internal.post(f.line("reply", 3));
    const key = "msg:000000000002",
      before = structuredClone(f.data.get(key));
    await f.internal.unmerge({ send: () => {} }, { thread: "owner", label: "page" }, "a");
    expect(f.data.get(key)).toEqual(before);
    expect((await f.hub.history()).map((m) => m.id)).toEqual(["a", "b", "reply"]);
    expect((await f.hub.replay("owner", 2)).messages.map((m) => [m.id, m.seq])).toEqual([
      ["a", 3],
      ["b", 4],
    ]);
  });
  it("rolls back partial head, row, and old-key deletion failures before any version is published", async () => {
    for (const stage of ["head", "row", "delete"]) {
      const f = fixture();
      await f.internal.post(f.line("a"));
      const before = structuredClone(f.data),
        put = f.storage.put,
        del = f.storage.delete;
      f.storage.put = async (key, value) => {
        await put(key, value);
        if ((stage === "head" && key === "seq") || (stage === "row" && key.startsWith("msg:")))
          throw new Error(stage);
      };
      f.storage.delete = async (key) => {
        const result = await del(key);
        if (stage === "delete") throw new Error(stage);
        return result;
      };
      await expect(
        f.internal.writeLine("msg:000000000001", { ...f.line("a"), text: "changed" }),
      ).rejects.toThrow(stage);
      expect(f.data).toEqual(before);
      f.storage.put = put;
      f.storage.delete = del;
      await f.internal.post(f.line("b", 2));
      expect((await f.hub.replay("owner", 0)).messages.map((m) => [m.id, m.seq, m.text])).toEqual([
        ["a", 1, "a"],
        ["b", 2, "b"],
      ]);
    }
  });
  it("new same-millisecond posts keep arrival order after a version change", async () => {
    const f = fixture();
    await f.internal.post(f.line("z", 10));
    await f.internal.post(f.line("a", 10));
    const [z, a] = await f.hub.history();
    expect(a.at).toBeGreaterThan(z.at);
    await f.internal.writeLine("msg:000000000001", { ...z, text: "edited" });
    expect((await f.hub.history()).map((m) => m.id)).toEqual(["z", "a"]);
    expect((await f.hub.history())[0].at).toBe(10);
  });
  it("reports pruning and tombstone coverage without returning removed content", async () => {
    const f = fixture();
    f.data.set("seq", CHAT_HISTORY + 5);
    f.data.set(`msg:${String(CHAT_HISTORY + 5).padStart(12, "0")}`, {
      ...f.line("gone"),
      removed: true,
    });
    const r = await f.hub.replay("owner", 0, undefined, 2);
    expect(r.prunedThroughSeq).toBe(5);
    expect(r.throughSeq).toBe(7);
    expect(r.skipped).toEqual([{ from: 6, to: 7 }]);
    const end = await f.hub.replay("owner", CHAT_HISTORY + 4);
    expect(end.messages).toEqual([]);
    expect(end.removed).toEqual([{ id: "gone", seq: CHAT_HISTORY + 5 }]);
    expect((await f.hub.history()).length).toBe(0);
  });
  it("clamps and persists explicit reads, coalesces a bounded burst, and never marks passive replay", async () => {
    const f = fixture();
    for (let n = 1; n <= 5; n++) await f.internal.post(f.line(String(n), n));
    await f.hub.replay("owner", 0);
    expect([...f.data.keys()].some((k) => k.startsWith("chat-read:"))).toBe(false);
    expect(await f.hub.acknowledgeRead("owner", "page:a", 2)).toBe(2);
    const a = f.hub.acknowledgeRead("owner", "page:a", 3),
      b = f.hub.acknowledgeRead("owner", "page:a", 999);
    await settle();
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0].ms).toBe(2000);
    f.tick(2000);
    f.timers.shift()!.run();
    expect(await a).toBe(5);
    expect(await b).toBe(5);
    f.tick(2000);
    expect(await f.hub.acknowledgeRead("owner", "page:a", 1)).toBe(5);
    expect(await f.hub.acknowledgeRead("friend", "page:a", 999)).toBe(0);
    expect(await f.hub.acknowledgeRead("owner", "token:b", 1)).toBe(1);
    expect(f.data.get("chat-read:owner:page%3Aa")).toBe(5);
    await expect(f.hub.acknowledgeRead("owner", "page:a", NaN)).rejects.toThrow(
      "invalid read cursor",
    );
  });
  it("keeps one next burst coalesced behind a slow write and waits from actual completion without blocking chat", async () => {
    const f = fixture();
    for (let n = 1; n <= 5; n++) await f.internal.post(f.line(String(n), n));
    const original = f.storage.put;
    let release!: () => void;
    let clock = 10000;
    const commits: { at: number; seq: unknown }[] = [];
    let slow = true;
    f.storage.put = async (key, value) => {
      if (key.startsWith("chat-read:")) {
        if (slow) {
          slow = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        commits.push({ at: clock, seq: value });
      }
      await original(key, value);
    };
    const first = f.hub.acknowledgeRead("owner", "page:a", 1);
    await settle();
    expect(release).toBeDefined();
    const second = f.hub.acknowledgeRead("owner", "page:a", 2);
    await settle();
    clock += 5000;
    f.tick(5000);
    const third = f.hub.acknowledgeRead("owner", "page:a", 3);
    await settle();
    expect(f.timers).toHaveLength(0);
    expect(commits).toHaveLength(0);
    release();
    expect(await first).toBe(1);
    await settle();
    expect(commits).toEqual([{ at: 15000, seq: 1 }]);
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0].ms).toBe(2000);
    const fourth = f.hub.acknowledgeRead("owner", "page:a", 4);
    await settle();
    expect(f.timers).toHaveLength(1);
    // The pending receipt's cooldown must not hold the shared thread sequence queue.
    expect(await f.internal.post(f.line("during-cooldown", 6))).toBe(6);
    expect((await f.hub.replay("owner", 5)).messages.map((m) => m.id)).toEqual(["during-cooldown"]);
    clock += 2000;
    f.tick(2000);
    f.timers.shift()!.run();
    expect(await second).toBe(4);
    expect(await third).toBe(4);
    expect(await fourth).toBe(4);
    expect(commits).toEqual([
      { at: 15000, seq: 1 },
      { at: 17000, seq: 4 },
    ]);
    expect(f.timers).toHaveLength(0);
  });
  it("binds resume and receipt presence to the authenticated thread and current page", async () => {
    const f = fixture();
    await f.internal.post(f.line("a"));
    await f.internal.post(f.line("b", 2));
    const who = {
      userId: "account",
      email: "unit@example.test",
      owner: true,
      name: "Device",
      session: "tag",
      sessionUntil: 100000000,
    };
    const open = async (tab: string, query = "", frame = false) => {
      const ws = new PageSocket();
      f.sockets.push(ws);
      await f.hub.connectPage(
        ws,
        new URL(
          `https://example.test/api/version/debug?tab=${tab}&label=private-path${query}${frame ? "&frame=foreign" : ""}`,
        ),
        who,
      );
      return ws;
    };
    const first = await open("page0001", "&afterThread=friend&afterSeq=2");
    expect((first.last("history")!.messages as ChatMessage[]).map((m) => m.id)).toEqual(["a", "b"]);
    const second = await open("page0002", "&afterThread=owner&afterSeq=1");
    expect((second.last("history")!.messages as ChatMessage[]).map((m) => m.id)).toEqual(["b"]);
    await f.hub.webSocketMessage(first, JSON.stringify({ type: "read", lastReadSeq: 999 }));
    expect(first.last("read-ack")).toEqual({ type: "read-ack", lastReadSeq: 2 });
    await f.hub.pushPresence("owner");
    const list = first.last("present")?.list as {
      key: string;
      self?: true;
      name: string;
      lastReadSeq: number;
    }[];
    expect(list.find((p) => p.key === "page:page0001")).toMatchObject({
      self: true,
      lastReadSeq: 2,
      name: "Device",
    });
    expect(list.find((p) => p.key === "page:page0002")?.self).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("private-path");
    const before = first.sent.length;
    await f.hub.webSocketMessage(
      first,
      JSON.stringify({ type: "replay", afterSeq: 0, thread: "friend" }),
    );
    expect(first.sent.length).toBe(before);
    const embedded = await open("page0003", "", true);
    await f.hub.webSocketMessage(embedded, JSON.stringify({ type: "read", lastReadSeq: 2 }));
    expect(embedded.last("read-ack")).toBeUndefined();
    expect(
      (embedded.last("present")!.list as { lastReadSeq?: number }[]).some(
        (p) => p.lastReadSeq !== undefined,
      ),
    ).toBe(false);
  });
  it("validates client cursor protocol and keeps version metadata through live patches", () => {
    for (const bad of [-1, 1.5, Infinity, "2", Number.MAX_SAFE_INTEGER + 1]) {
      expect(parsePageMessage(JSON.stringify({ type: "read", lastReadSeq: bad }))).toBeNull();
      expect(parsePageMessage(JSON.stringify({ type: "replay", afterSeq: bad }))).toBeNull();
    }
    expect(
      parsePageMessage(JSON.stringify({ type: "read", lastReadSeq: 2, thread: "other" })),
    ).toBeNull();
    expect(
      parsePageMessage(
        JSON.stringify({ type: "read", lastReadSeq: 2, padding: "x".repeat(100000) }),
      ),
    ).toBeNull();
    expect(
      parsePageMessage(JSON.stringify({ type: "replay", afterSeq: 4, throughSeq: 3 })),
    ).toBeNull();
    expect(
      parsePageMessage(JSON.stringify({ type: "replay", afterSeq: 2, throughSeq: 4 })),
    ).toEqual({ type: "replay", afterSeq: 2, throughSeq: 4 });
    const f = fixture(),
      m = f.line("a");
    expect(
      applyEdit(m, {
        id: "a",
        thread: "owner",
        seq: 9,
        text: "new",
        raw: "a",
        edited: { at: 1, by: "x", count: 1 },
      }).seq,
    ).toBe(9);
    const ask = { ...m, ask: { askId: "q", questions: [] } };
    expect(
      applyWithdrawn(ask, { id: "a", askId: "q", thread: "owner", seq: 10, withdrawnAt: 1 }).seq,
    ).toBe(10);
    expect(
      parsePresent([{ key: "page:a", name: "A", active: 1, lastReadSeq: -1, self: false }]),
    ).toEqual([{ key: "page:a", name: "A", active: 1 }]);
    expect(
      parsePresent([{ key: "page:a", name: "A", active: 1, lastReadSeq: 4, self: true }])?.[0],
    ).toMatchObject({ lastReadSeq: 4, self: true });
  });
});
