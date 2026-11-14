import { describe, expect, test } from "bun:test";
import {
  acknowledgedChatIds,
  hasChatRejection,
  createChatOutbox,
  type OutgoingChat,
} from "../packages/debug-chat/src/chat-outbox";

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
      { id: "long", text: "x".repeat(20_001) },
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
