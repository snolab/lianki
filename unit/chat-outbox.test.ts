import { describe, expect, test } from "bun:test";
import {
  acknowledgedChatIds,
  hasChatRejection,
  createChatOutbox,
  migrateSessionOutbox,
  ACK_BACKOFF_CAP,
  NO_RECEIPT,
  splitChatText,
  splitOutgoing,
  type OutgoingChat,
} from "../packages/debug-chat/src/chat-outbox";
import { MAX_CHAT } from "../packages/debug-chat/src/wire";

/** Durable bytes survive a page reload; callbacks and in-flight state do not. */
function fixture(initial: unknown = []) {
  let stored: unknown = initial;
  let n = 0;
  let now = 100;
  let online = true;
  let throws = false;
  const attempts: { at: number; item: OutgoingChat }[] = [];
  const rejections: { item: OutgoingChat; reason: string }[] = [];
  const writes: OutgoingChat[][] = [];
  const make = () =>
    createChatOutbox({
      read: () => structuredClone(stored),
      write: (items) => {
        stored = structuredClone(items);
        writes.push(structuredClone(items));
      },
      send: (item) => {
        attempts.push({ at: now, item: structuredClone(item) });
        if (throws) throw Error("network disappeared");
        return online;
      },
      id: () => `pending-${++n}`,
      onRejected: (item, reason) => rejections.push({ item, reason }),
      onChange: () => {},
    });
  return {
    make,
    attempts,
    rejections,
    writes,
    stored: () => stored,
    tick: (ms: number) => {
      now += ms;
    },
    online: (v: boolean) => {
      online = v;
    },
    throws: (v: boolean) => {
      throws = v;
    },
  };
}

describe("persistent outgoing chat", () => {
  test("matching legacy rate warnings are suppressed only for durably recorded rejections, including after reload", () => {
    const f = fixture();
    const q = f.make();
    q.enqueue({ text: "refused line" });
    q.enqueue({ text: "still pending" });
    q.ready();
    expect(hasChatRejection(q.items(), "pending-1")).toBe(false);
    q.reject("pending-1", "rate limited");
    expect(hasChatRejection(q.items(), "pending-1")).toBe(true);
    expect(hasChatRejection(q.items(), "pending-2")).toBe(false);
    expect(hasChatRejection(q.items(), "unrelated")).toBe(false);
    expect(hasChatRejection(q.items(), undefined)).toBe(false);
    expect(hasChatRejection(q.items(), null)).toBe(false);
    q.dispose();
    const reload = f.make();
    expect(hasChatRejection(reload.items(), "pending-1")).toBe(true);
    expect(hasChatRejection(reload.items(), "pending-2")).toBe(false);
    expect(f.rejections).toHaveLength(1);
  });
  test("caller, transport and rendered snapshots cannot mutate the durable pending payload", () => {
    let saved: OutgoingChat[] = [];
    const q = createChatOutbox({
      read: () => [],
      write: (items) => {
        saved = structuredClone(items);
      },
      send: (item) => {
        (item.context as { selection: string }).selection = "transport mutation";
        return true;
      },
      id: () => "immutable",
      onRejected: () => {},
    });
    const payload = {
      text: "spoken",
      source: "stt",
      context: { selection: "original selection" },
      speakerProof: ["original proof"],
    };
    q.enqueue(payload);
    payload.context.selection = "caller mutation";
    payload.speakerProof[0] = "caller changed proof";
    q.ready();
    const snapshot = q.items()[0]!;
    expect(snapshot.context).toEqual({ selection: "original selection" });
    expect(snapshot.speakerProof).toEqual(["original proof"]);
    (snapshot.context as { selection: string }).selection = "render mutation";
    expect(q.items()[0]!.context).toEqual({ selection: "original selection" });
    expect(saved[0]!.context).toEqual({ selection: "original selection" });
  });

  test("a payload that cannot be durably encoded stays with its caller instead of being sent or silently lost", () => {
    const f = fixture();
    const q = f.make();
    q.ready();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(q.enqueue({ text: "keep this draft", context: circular })).toBe(false);
    expect(q.items()).toEqual([]);
    expect(f.attempts).toEqual([]);
    expect(f.stored()).toEqual([]);
  });
  test("the per-thread server cursor survives reload and never regresses on old or duplicate acknowledgements", () => {
    let persisted = 7;
    const writes: number[] = [];
    const make = () =>
      createChatOutbox({
        read: () => [],
        write: () => {},
        send: () => true,
        id: () => "id",
        onRejected: () => {},
        readCursor: () => persisted,
        writeCursor: (seq) => {
          persisted = seq;
          writes.push(seq);
        },
      });
    const q = make();
    expect(q.cursor()).toBe(7);
    q.acknowledge(["already-accepted"], 9);
    q.acknowledge(["duplicate"], 9);
    q.acknowledge(["late"], 8);
    q.ready([], 6);
    expect(q.cursor()).toBe(9);
    expect(persisted).toBe(9);
    for (const seq of [-1, 0.5, NaN, Infinity]) q.acknowledge([], seq);
    expect(q.cursor()).toBe(9);
    q.dispose();
    q.acknowledge([], 99);
    expect(persisted).toBe(9);
    const reload = make();
    expect(reload.cursor()).toBe(9);
    reload.ready([], 12);
    expect(reload.cursor()).toBe(12);
    expect(writes.every((seq, i) => i === 0 || seq >= writes[i - 1]!)).toBe(true);
  });

  test("invalid or inaccessible cursor storage starts at zero without blocking delivery", () => {
    for (const persisted of [undefined, "9", -1, 1.5, NaN, Infinity]) {
      const q = createChatOutbox({
        read: () => [],
        write: () => {},
        send: () => true,
        id: () => "id",
        onRejected: () => {},
        readCursor: () => persisted,
      });
      expect(q.cursor()).toBe(0);
    }
    const q = createChatOutbox({
      read: () => [],
      write: () => {},
      send: () => true,
      id: () => "id",
      onRejected: () => {},
      readCursor: () => {
        throw Error("storage unavailable");
      },
      writeCursor: () => {
        throw Error("quota");
      },
    });
    expect(q.cursor()).toBe(0);
    expect(() => q.acknowledge([], 2)).not.toThrow();
    expect(q.cursor()).toBe(2);
  });
  test("restores only valid distinct pending messages and tolerates unavailable storage", () => {
    const f = fixture([
      null,
      7,
      {},
      { id: 4, text: "bad" },
      { id: "", text: "bad" },
      { id: "x".repeat(129), text: "bad" },
      { id: "empty", text: " " },
      { id: "not-text", text: 7 },
      { id: "long", text: "x".repeat(200_001) },
      { id: "valid", text: "restored", source: "stt" },
      { id: "valid", text: "duplicate" },
    ]);
    const q = f.make();
    expect(q.items()).toEqual([{ id: "valid", text: "restored", source: "stt" }]);
    q.ready();
    expect(f.attempts).toHaveLength(1);
    expect(fixture({ invalid: "not an array" }).make().items()).toEqual([]);
    let failedStoreSends = 0;
    const memory = createChatOutbox({
      read: () => {
        throw Error("storage disabled");
      },
      write: () => {
        throw Error("quota");
      },
      send: () => {
        failedStoreSends++;
        return true;
      },
      id: () => "memory",
      onRejected: () => {},
    });
    expect(memory.enqueue({ text: "keep in the input" })).toBe(false);
    expect(memory.items()).toEqual([]);
    expect(memory.enqueue({ text: " " })).toBe(false);
    memory.ready();
    expect(failedStoreSends).toBe(0);
    memory.acknowledge(["memory"]);
    memory.dispose();
    expect(memory.enqueue({ text: "stale callback" })).toBe(false);
    memory.reject("memory", "stale rejection");
  });

  test("history includes merged client ids as acknowledgements without relying on repeated text", () => {
    expect(acknowledgedChatIds([])).toEqual([]);
    const ids = acknowledgedChatIds([
      { id: "merged", parts: [{ id: "pending-1" }, { id: "pending-2" }] },
      { id: "other" },
    ]);
    expect(ids).toEqual(["merged", "pending-1", "pending-2", "other"]);
    const f = fixture();
    const q = f.make();
    q.enqueue({ text: "part one", source: "stt" });
    q.enqueue({ text: "part two", source: "stt" });
    q.ready(ids);
    expect(q.items()).toEqual([]);
    expect(f.attempts).toEqual([]);
  });
  test("persists before transmission and sends FIFO with one unacknowledged item", () => {
    const f = fixture();
    const q = f.make();
    expect(q.enqueue({ text: "typed first" })).toBe(true);
    expect(q.enqueue({ text: "spoken second", source: "stt" })).toBe(true);
    expect(f.attempts).toEqual([]);
    expect(f.stored()).toEqual([
      { id: "pending-1", text: "typed first" },
      { id: "pending-2", text: "spoken second", source: "stt" },
    ]);
    q.ready();
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1"]);
    q.enqueue({ text: "third" });
    expect(f.attempts).toHaveLength(1);
    q.acknowledge(["pending-1"]);
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-2"]);
    q.acknowledge(["pending-2"]);
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-2", "pending-3"]);
    q.acknowledge(["pending-3"]);
    expect(q.items()).toEqual([]);
    expect(f.stored()).toEqual([]);
  });

  test("reload before acknowledgement replays the original id and immutable voice metadata", () => {
    const f = fixture();
    const q = f.make();
    const payload = {
      text: "spoken",
      source: "stt",
      to: "/words",
      continues: "prior",
      speakerProof: ["local-proof"],
      timing: { t_sttDone: 90 },
      context: { selection: "selection" },
    };
    q.enqueue(payload);
    q.ready();
    const first = structuredClone(f.attempts[0]!.item);
    q.dispose();
    f.tick(5000);
    const reloaded = f.make();
    expect(f.attempts).toHaveLength(1);
    reloaded.ready();
    expect(f.attempts[1]!.item).toEqual(first);
    expect(f.attempts[1]!.at).toBe(5100);
    reloaded.acknowledge([first.id]);
    reloaded.dispose();
    f.make().ready();
    expect(f.attempts).toHaveLength(2);
  });

  test("history acknowledgement reconciles before a reconnect can replay", () => {
    const f = fixture();
    const q = f.make();
    q.enqueue({ text: "already reached hub" });
    q.enqueue({ text: "not delivered" });
    q.ready();
    q.dispose();
    const reload = f.make();
    reload.ready(["pending-1"]);
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-2"]);
    expect(reload.items().map((m) => m.id)).toEqual(["pending-2"]);
  });

  test("a false transport remains quiet and reconnect resumes FIFO with the same id", () => {
    const f = fixture();
    f.online(false);
    const q = f.make();
    q.enqueue({ text: "first" });
    q.enqueue({ text: "second" });
    q.ready();
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1"]);
    f.tick(60_000);
    expect(f.attempts).toHaveLength(1);
    expect(f.rejections).toEqual([]);
    q.disconnect();
    f.online(true);
    q.ready();
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-1"]);
    q.acknowledge(["pending-1"]);
    expect(f.attempts.at(-1)!.item.id).toBe("pending-2");
  });

  test("transport exceptions are transient and do not reject or discard the message", () => {
    const f = fixture();
    f.throws(true);
    const q = f.make();
    q.enqueue({ text: "keep me" });
    expect(() => q.ready()).not.toThrow();
    expect(q.items()).toHaveLength(1);
    expect(f.rejections).toEqual([]);
    f.throws(false);
    q.disconnect();
    q.ready();
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-1"]);
  });

  test("explicit rejection reports once, retains blocked text across reload and advances later pending items", () => {
    const f = fixture();
    const q = f.make();
    q.enqueue({ text: "rejected" });
    q.enqueue({ text: "next" });
    q.ready();
    q.reject("pending-1", "permission denied");
    q.reject("pending-1", "repeated denial");
    q.reject("unknown", "not ours");
    expect(f.rejections).toEqual([
      {
        item: { id: "pending-1", text: "rejected", rejected: "permission denied" },
        reason: "permission denied",
      },
    ]);
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-2"]);
    expect(q.items().find((m) => m.id === "pending-1")?.text).toBe("rejected");
    expect(JSON.stringify(f.stored())).toContain("permission denied");
    q.dispose();
    const reload = f.make();
    reload.reject("pending-1", "late duplicate denial");
    expect(f.rejections).toHaveLength(1);
    expect(reload.items().map((m) => m.id)).toEqual(["pending-1", "pending-2"]);
    reload.ready();
    expect(f.attempts.at(-1)!.item.id).toBe("pending-2");
    expect(f.attempts.filter((a) => a.item.id === "pending-1")).toHaveLength(1);
  });

  test("malformed or unrelated rejection events cannot block, erase or resend a known pending line", () => {
    const f = fixture();
    const q = f.make();
    q.enqueue({ text: "valid pending line" });
    q.ready();
    q.reject("unrelated-id", "unrelated error");
    q.reject("pending-1", "");
    q.reject("pending-1", "   ");
    expect(f.rejections).toEqual([]);
    expect(f.attempts).toHaveLength(1);
    expect(q.items()).toEqual([{ id: "pending-1", text: "valid pending line" }]);
  });

  test("malformed persisted rejection markers cannot permanently block restored delivery", () => {
    for (const rejected of ["", "   ", false, 7, { reason: "not a marker" }]) {
      const f = fixture([{ id: "restored", text: "still pending", rejected }]);
      const q = f.make();
      q.ready();
      expect(q.items()[0]!.rejected).toBeUndefined();
      expect(f.attempts.map((a) => a.item.id)).toEqual(["restored"]);
      expect(f.rejections).toEqual([]);
    }
  });

  test("duplicate or unrelated echo acknowledgements never skip or resend later items", () => {
    const f = fixture();
    const q = f.make();
    q.enqueue({ text: "same sentence" });
    q.enqueue({ text: "same sentence" });
    q.ready();
    q.acknowledge(["other-device-id"]);
    expect(q.items()).toHaveLength(2);
    q.acknowledge(["pending-1", "pending-1"]);
    q.acknowledge(["pending-1"]);
    expect(f.attempts.map((a) => a.item.id)).toEqual(["pending-1", "pending-2"]);
    expect(q.items().map((m) => m.id)).toEqual(["pending-2"]);
    q.acknowledge(["pending-2"]);
    q.disconnect();
    q.ready(["pending-1", "pending-2"]);
    expect(f.attempts).toHaveLength(2);
  });

  test("account-bound stores and replacement instances never send another account's data", () => {
    const a = fixture();
    const b = fixture();
    const old = a.make();
    old.enqueue({ text: "private a" });
    old.ready();
    old.dispose();
    const replacement = a.make();
    const other = b.make();
    other.enqueue({ text: "private b", source: "stt" });
    other.ready();
    old.ready();
    old.acknowledge(["pending-1"]);
    expect(a.attempts).toHaveLength(1);
    replacement.ready();
    expect(a.attempts.at(-1)!.item.text).toBe("private a");
    expect(b.attempts.map((x) => x.item.text)).toEqual(["private b"]);
    expect(replacement.items()[0]!.text).toBe("private a");
  });
});

/** A fake clock and a store shared by every outbox made from it (two tabs on one device). */
function clock(
  opts: {
    timeout?: number | (() => number);
    random?: () => number;
    maxResends?: number | (() => number);
  } = {},
) {
  let now = 0;
  let nextHandle = 0;
  let stored: unknown = [];
  let n = 0;
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const sends: { tab: string; id: string; at: number }[] = [];
  const delays: number[] = [];
  const refused: { id: string; reason: string }[] = [];
  const tab = (name: string, online = () => true) =>
    createChatOutbox({
      shared: true,
      read: () => structuredClone(stored),
      write: (items) => {
        stored = structuredClone(items);
      },
      send: (item) => {
        sends.push({ tab: name, id: item.id, at: now });
        return online();
      },
      id: () => `line-${++n}`,
      onRejected: (item, reason) => refused.push({ id: item.id, reason }),
      ackTimeoutMs: opts.timeout ?? 1000,
      maxResends: opts.maxResends,
      random: opts.random ?? (() => 0),
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.set(++nextHandle, { at: now + ms, fn, ms });
        return nextHandle;
      },
      clearTimer: (h) => {
        timers.delete(h as number);
      },
    });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { tab, advance, sends, delays, timers, refused, stored: () => stored };
}

describe("receipt timeout and the durable queue", () => {
  test("a line in flight with no receipt is sent again, same id, after the timeout", () => {
    const c = clock();
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "hello" });
    expect(c.sends).toEqual([{ tab: "a", id: "line-1", at: 0 }]);
    c.advance(999);
    expect(c.sends).toHaveLength(1);
    c.advance(1);
    expect(c.sends.map((s) => [s.id, s.at])).toEqual([
      ["line-1", 0],
      ["line-1", 1000],
    ]);
    expect(q.items().map((i) => i.id)).toEqual(["line-1"]);
  });

  test("back-off doubles up to the cap and resets after a receipt", () => {
    const c = clock();
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "one" });
    q.enqueue({ text: "two" });
    c.advance(60_000);
    const gaps = c.sends.slice(1).map((s, i) => s.at - c.sends[i]!.at);
    expect(gaps.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(Math.max(...gaps)).toBe(1000 * ACK_BACKOFF_CAP);
    expect(c.sends.every((s) => s.id === "line-1")).toBe(true);
    q.acknowledge(["line-1"], 5);
    expect(c.sends.at(-1)!.id).toBe("line-2");
    expect(c.delays.at(-1)).toBe(1000);
    q.acknowledge(["line-2"]);
    expect(q.items()).toEqual([]);
    expect(c.timers.size).toBe(0);
  });

  test("a late receipt after a resend clears the line once and sends the next once", () => {
    const c = clock();
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "slow" });
    q.enqueue({ text: "next" });
    c.advance(1000);
    expect(c.sends.map((s) => s.id)).toEqual(["line-1", "line-1"]);
    q.acknowledge(["line-1"]);
    q.acknowledge(["line-1"]);
    expect(q.items().map((i) => i.text)).toEqual(["next"]);
    expect(c.sends.map((s) => s.id)).toEqual(["line-1", "line-1", "line-2"]);
    q.acknowledge(["line-2"]);
    c.advance(100_000);
    expect(c.sends).toHaveLength(3);
  });

  test("no timeout configured, a disconnect, a refusal or dispose stop the resend timer", () => {
    const off = clock({ timeout: 0 });
    const quiet = off.tab("a");
    quiet.ready();
    quiet.enqueue({ text: "wait forever" });
    expect(off.timers.size).toBe(0);
    const broken = clock({
      timeout: () => {
        throw Error("config");
      },
      random: () => Number.NaN,
    });
    broken.tab("a").ready();
    const c = clock({ random: () => 2 });
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "x" });
    expect(c.delays).toEqual([1250]);
    q.disconnect();
    expect(c.timers.size).toBe(0);
    q.ready();
    q.reject("line-1", "blocked");
    expect(c.timers.size).toBe(0);
    q.enqueue({ text: "y" });
    expect(c.timers.size).toBe(1);
    q.dispose();
    expect(c.timers.size).toBe(0);
    const offline = clock();
    let up = false;
    const o = offline.tab("a", () => up);
    o.ready();
    o.enqueue({ text: "z" });
    expect(offline.timers.size).toBe(0);
    up = true;
    o.ready();
    expect(offline.timers.size).toBe(1);
  });

  test("a resend timer that fires after its line landed elsewhere does nothing", () => {
    const c = clock();
    const a = c.tab("a");
    const b = c.tab("b");
    a.ready();
    a.enqueue({ text: "shared" });
    b.ready();
    b.acknowledge(["line-1"]);
    a.refresh();
    expect(a.items()).toEqual([]);
    c.advance(10_000);
    expect(c.sends.filter((s) => s.tab === "a")).toHaveLength(1);
    a.dispose();
    a.refresh();
  });

  test("two tabs share one stored queue: neither overwrites the other's lines", () => {
    const c = clock({ random: () => 0.5 });
    const a = c.tab("a");
    const b = c.tab("b");
    a.enqueue({ text: "from a" });
    b.enqueue({ text: "from b" });
    expect((c.stored() as OutgoingChat[]).map((i) => i.text)).toEqual(["from a", "from b"]);
    b.ready();
    expect(c.sends).toEqual([{ tab: "b", id: "line-1", at: 0 }]);
    expect(c.delays).toEqual([1125]);
    b.acknowledge(["line-1"]);
    a.reject("line-2", "blocked");
    expect((c.stored() as OutgoingChat[])[0]!.rejected).toBe("blocked");
    b.refresh();
    expect(b.items().map((i) => i.rejected)).toEqual(["blocked"]);
  });

  test("a closed tab's lines are sent by the next tab on that device", () => {
    const c = clock();
    const closed = c.tab("a");
    closed.enqueue({ text: "left behind" });
    closed.dispose();
    const next = c.tab("b");
    next.ready();
    expect(c.sends.map((s) => [s.tab, s.id])).toEqual([["b", "line-1"]]);
  });
});

describe("giving up after the resend cap", () => {
  test("after the cap the line is marked unsent and the next line goes out", () => {
    const c = clock({ maxResends: 2 });
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "lost" });
    q.enqueue({ text: "behind" });
    c.advance(1000 + 2000);
    expect(c.sends.map((s) => s.id)).toEqual(["line-1", "line-1", "line-1"]);
    c.advance(3999);
    expect(c.sends).toHaveLength(3);
    c.advance(1);
    expect(q.items().map((i) => [i.id, i.rejected])).toEqual([
      ["line-1", NO_RECEIPT],
      ["line-2", undefined],
    ]);
    expect(c.refused).toEqual([{ id: "line-1", reason: NO_RECEIPT }]);
    expect(c.sends.at(-1)!.id).toBe("line-2");
    // The next line starts with a fresh wait, not the lost line's back-off.
    expect(c.delays.at(-1)).toBe(1000);
    q.acknowledge(["line-2"]);
    c.advance(100_000);
    expect(c.sends.filter((s) => s.id === "line-1")).toHaveLength(3);
  });

  test("a late receipt still removes a line marked unsent", () => {
    const c = clock({ maxResends: () => 1 });
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "late" });
    c.advance(1000 + 2000);
    expect(q.items()[0]!.rejected).toBe(NO_RECEIPT);
    q.acknowledge(["line-1"], 3);
    expect(q.items()).toEqual([]);
    expect(q.cursor()).toBe(3);
  });

  test("a cap of 0 never gives up", () => {
    const c = clock({ maxResends: 0 });
    const q = c.tab("a");
    q.ready();
    q.enqueue({ text: "keep trying" });
    c.advance(1_000_000);
    expect(c.sends.length).toBeGreaterThan(100);
    expect(q.items()[0]!.rejected).toBeUndefined();
    expect(c.refused).toEqual([]);
  });
});

describe("migration from the per-tab queue", () => {
  const store = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  const line = (id: string) => ({ id, text: id });

  test("moves session lines and cursor into localStorage once, after lines already there", () => {
    const session = store({
      k: JSON.stringify([line("old"), line("both"), { id: 3 }]),
      "k:cursor": "9",
    });
    const local = store({ k: JSON.stringify([line("both"), line("new")]), "k:cursor": "4" });
    migrateSessionOutbox("k", session, local);
    expect(JSON.parse(local.m.get("k")!).map((i: OutgoingChat) => i.id)).toEqual([
      "both",
      "new",
      "old",
    ]);
    expect(local.m.get("k:cursor")).toBe("9");
    expect(session.m.size).toBe(0);
    migrateSessionOutbox("k", session, local);
    expect(JSON.parse(local.m.get("k")!)).toHaveLength(3);
  });

  test("keeps the larger cursor, survives damaged bytes, and leaves nothing to migrate alone", () => {
    const session = store({ k: JSON.stringify([line("a")]), "k:cursor": "2" });
    const local = store({ k: "{not json", "k:cursor": "nope" });
    migrateSessionOutbox("k", session, local);
    expect(JSON.parse(local.m.get("k")!)).toEqual([line("a")]);
    expect(local.m.get("k:cursor")).toBe("2");
    const s2 = store({ "k:cursor": "1" });
    const l2 = store({ "k:cursor": "7" });
    migrateSessionOutbox("k", s2, l2);
    expect(l2.m.get("k:cursor")).toBe("7");
    expect(s2.m.size).toBe(0);
    const s3 = store({ k: "[]" });
    const l3 = store();
    migrateSessionOutbox("k", s3, l3);
    expect(l3.m.has("k")).toBe(false);
    const empty = store();
    migrateSessionOutbox("k", empty, store());
    migrateSessionOutbox("k", store({ k: "{broken" }), store());
  });
});

describe("a line over MAX_CHAT goes out as several", () => {
  const para = (n: number) => `${"这是一句很长的话，".repeat(n)}结束。`;
  test("cut at paragraphs, then sentences, then clauses, spaces, else hard; nothing lost", () => {
    expect(splitChatText("short")).toEqual(["short"]);
    const text = `${para(200)}\n\n${para(200)}\n\n${para(200)}`;
    const parts = splitChatText(text, 3000);
    expect(parts.every((p) => p.length <= 3000)).toBe(true);
    expect(parts.join("")).toBe(text.replace(/\s+/g, ""));
    expect(parts[0]!.endsWith("结束。")).toBe(true);
    // No paragraph: a sentence end.
    const sentences = "One two three. ".repeat(40).trim();
    for (const p of splitChatText(sentences, 100)) expect(p.endsWith(".")).toBe(true);
    // A clause, then a space.
    expect(splitChatText("甲，".repeat(60), 50).every((p) => p.length <= 50)).toBe(true);
    expect(splitChatText("word ".repeat(50).trim(), 32).every((p) => !p.startsWith(" "))).toBe(
      true,
    );
    // No break at all: a hard cut, every character kept.
    const solid = "字".repeat(250);
    expect(splitChatText(solid, 100)).toEqual([
      "字".repeat(100),
      "字".repeat(100),
      "字".repeat(50),
    ]);
  });

  test("parts keep the first id, drop whole-line proofs, carry the selection once", () => {
    const item: OutgoingChat = {
      id: "abc",
      text: "字".repeat(MAX_CHAT + 10),
      source: "stt",
      speakerProof: ["p"],
      recheck: { x: 1 },
      context: { selection: "s" },
      to: "/w",
    };
    const parts = splitOutgoing(item);
    expect(parts.map((p) => p.id)).toEqual(["abc", "abc-2"]);
    expect(parts.every((p) => p.text.length <= MAX_CHAT && p.speakerProof === undefined)).toBe(
      true,
    );
    expect(parts[0]!.context).toEqual({ selection: "s" });
    expect(parts[1]!.context).toBeUndefined();
    expect(parts.every((p) => p.to === "/w" && p.source === "stt")).toBe(true);
    expect(splitOutgoing({ id: "x", text: "ok" })).toEqual([{ id: "x", text: "ok" }]);
  });

  test("enqueue sends the parts in order; a stored long line, even one marked no-receipt, is cut on load", () => {
    const f = fixture();
    const q = f.make();
    q.ready();
    q.enqueue({ text: "字".repeat(MAX_CHAT * 2 + 5) });
    expect(q.items().map((i) => i.text.length)).toEqual([MAX_CHAT, MAX_CHAT, 5]);
    expect(f.attempts[0]!.item.id).toBe("pending-1");
    q.ready(["pending-1"]);
    expect(f.attempts.at(-1)!.item.id).toBe("pending-1-2");

    const g = fixture([
      { id: "old", text: "字".repeat(MAX_CHAT + 1), rejected: NO_RECEIPT },
      { id: "refused", text: "字".repeat(MAX_CHAT + 1), rejected: "rate" },
    ]);
    const r = g.make();
    expect(r.items().map((i) => [i.id, i.rejected])).toEqual([
      ["old", undefined],
      ["old-2", undefined],
      ["refused", "rate"],
      ["refused-2", "rate"],
    ]);
    r.ready();
    expect(g.attempts[0]!.item.id).toBe("old");
  });
});
