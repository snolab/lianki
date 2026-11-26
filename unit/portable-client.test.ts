import { describe, expect, test } from "bun:test";
import {
  PORTABLE_HISTORY_MAX,
  createPortableClient,
  isAdvanced,
  mergeRange,
  type PortableCall,
  type PortableInput,
} from "../packages/debug-chat/src/embed/portable-client";
import type { ChatMessage, ChatReplayRange } from "../packages/debug-chat/src/wire";

const turn = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const msg = (i: number, from: ChatMessage["from"] = "agent"): ChatMessage => ({
  id: "m" + i,
  from,
  label: "",
  text: "line " + i,
  at: i,
  seq: i,
});
const range = (p: Partial<ChatReplayRange>): ChatReplayRange => ({
  type: "history",
  thread: "t",
  messages: [],
  removed: [],
  skipped: [],
  afterSeq: 0,
  throughSeq: 0,
  headSeq: 0,
  prunedThroughSeq: 0,
  ...p,
});
const doc = () => {
  const fns = new Set<(e?: unknown) => void>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: string, fn: (e?: unknown) => void) => void fns.add(fn),
    removeEventListener: (_t: string, fn: (e?: unknown) => void) => void fns.delete(fn),
    fire() {
      for (const f of fns) f();
    },
    count: () => fns.size,
  };
};
/** A broker that answers the first read with history, then parks until aborted. */
function broker(first: ChatReplayRange, opts: { send?: (i: PortableInput) => unknown } = {}) {
  const seen: PortableInput[] = [];
  let reads = 0;
  let wake: ((v: unknown) => void) | undefined;
  const call: PortableCall = async (input, _p, signal) => {
    seen.push(input);
    if (input.op === "send")
      return (opts.send?.(input) ?? { ok: true, kind: "accepted", id: input.id, seq: 50 }) as never;
    if (reads++ === 0) return { ok: true, kind: "history", range: first };
    return new Promise((resolve) => {
      wake = resolve as (v: unknown) => void;
      signal?.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" }), {
        once: true,
      });
    });
  };
  return { call, seen, wake: (v: unknown) => wake?.(v) };
}

describe("mergeRange", () => {
  test("adds, removes, prunes and keeps at most the history bound, in time order", () => {
    const kept = [msg(1), msg(2), msg(3)];
    const out = mergeRange(
      kept,
      range({ messages: [msg(5), msg(4)], removed: [{ id: "m2", seq: 6 }], prunedThroughSeq: 1 }),
    );
    expect(out.map((m) => m.id)).toEqual(["m3", "m4", "m5"]);
    const many = mergeRange(
      [],
      range({ messages: Array.from({ length: PORTABLE_HISTORY_MAX + 5 }, (_, i) => msg(i + 1)) }),
    );
    expect(many).toHaveLength(PORTABLE_HISTORY_MAX);
    expect(many[0].id).toBe("m6");
  });
});

describe("isAdvanced", () => {
  test("a node address, page context or files are advanced; plain text is not", () => {
    expect(isAdvanced()).toBe(false);
    expect(isAdvanced(undefined, {})).toBe(false);
    expect(isAdvanced("/plan")).toBe(true);
    expect(isAdvanced(undefined, { context: { text: "sel" } })).toBe(true);
    expect(isAdvanced(undefined, { attachments: [{}] })).toBe(true);
    expect(isAdvanced(undefined, { attachments: [] })).toBe(false);
  });
});

describe("createPortableClient", () => {
  test("reads history, sends only read/send ops, and shows the line at once", async () => {
    const b = broker(range({ messages: [msg(1)], throughSeq: 1 }));
    const d = doc();
    const c = createPortableClient({
      call: b.call,
      principal: "acct",
      doc: d,
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    await turn();
    expect(c.get().live).toBe(true);
    expect(c.get().messages.map((m) => m.id)).toEqual(["m1"]);
    expect(c.send("  hello  ")).toBe(true);
    expect(c.get().outgoing.map((o) => o.text)).toEqual(["hello"]);
    await turn();
    expect(c.get().outgoing).toEqual([]);
    expect(c.get().messages.at(-1)?.text).toBe("hello");
    expect(c.get().busy).toEqual({ label: "Li" });
    expect(b.seen.every((i) => i.op === "read" || i.op === "send")).toBe(true);
    const sent = b.seen.find((i) => i.op === "send") as Extract<PortableInput, { op: "send" }>;
    expect(sent.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(Object.keys(sent).sort()).toEqual(["id", "op", "text"]);
    // The second read is the long poll, from the last seq.
    expect(b.seen[1]).toEqual({ op: "read", afterSeq: 1, wait: true });
    c.stop();
    expect(d.count()).toBe(0);
  });

  test("an advanced action is refused locally: nothing is sent, the hint shows, the draft stays", async () => {
    const b = broker(range({}));
    const c = createPortableClient({
      call: b.call,
      principal: "acct",
      doc: doc(),
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    await turn();
    expect(c.send("look", "/plan")).toBe(false);
    expect(c.send("look", undefined, { context: { text: "page" } })).toBe(false);
    expect(c.get().problem).toBe("advanced");
    expect(b.seen.some((i) => i.op === "send")).toBe(false);
    // A plain line afterwards clears the hint.
    expect(c.send("plain")).toBe(true);
    expect(c.get().problem).toBeUndefined();
    c.stop();
  });

  test("a failed send marks the line unsent with its reason and a warning", async () => {
    const b = broker(range({}), { send: () => ({ ok: false, error: "busy" }) });
    const c = createPortableClient({
      call: b.call,
      principal: "acct",
      doc: doc(),
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    await turn();
    c.send("hi");
    await turn();
    expect(c.get().outgoing).toEqual([expect.objectContaining({ text: "hi", rejected: "failed" })]);
    expect(c.get().problem).toBe("failed");
    c.stop();
  });

  test("stop aborts a send in flight through its signal; a late answer adds nothing (review #1123 P2)", async () => {
    let sendSignal: AbortSignal | undefined;
    let answer!: (v: unknown) => void;
    const call: PortableCall = async (input, _p, signal) => {
      if (input.op === "send") {
        sendSignal = signal;
        return new Promise((r) => (answer = r as never)) as never;
      }
      return new Promise((r) =>
        signal?.addEventListener("abort", () => r({ ok: false, error: "cancelled" })),
      );
    };
    const c = createPortableClient({
      call,
      principal: "acct",
      doc: doc(),
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    let heard = 0;
    c.subscribe(() => heard++);
    c.send("synthetic cancellation");
    await turn();
    expect(sendSignal).toBeDefined();
    expect(sendSignal!.aborted).toBe(false);
    c.stop();
    expect(sendSignal!.aborted).toBe(true);
    const before = heard;
    answer({ ok: true, kind: "accepted", id: "late_accept", seq: 9 });
    await turn();
    expect(heard).toBe(before);
    expect(c.get().messages).toEqual([]);
  });

  test("a send the transport reports cancelled leaves no row pending and no failure", async () => {
    const b = broker(range({}), { send: () => ({ ok: false, error: "cancelled" }) });
    const c = createPortableClient({
      call: b.call,
      principal: "acct",
      doc: doc(),
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    await turn();
    c.send("hi");
    await turn();
    expect(c.get().outgoing).toEqual([]);
    expect(c.get().problem).toBeUndefined();
    c.stop();
  });

  test("signed out or another account closes it through the host", async () => {
    let invalid = 0;
    const call: PortableCall = async () => ({ ok: false, error: "account-changed" });
    const c = createPortableClient({
      call,
      principal: "acct",
      doc: doc(),
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount: () => invalid++,
    });
    await turn();
    expect(invalid).toBe(1);
    expect(c.send("x")).toBe(true);
    await turn();
    expect(invalid).toBe(2);
    c.stop();
  });

  test("hidden stops the read and goes offline; visible reads again; subscribers hear changes until they leave", async () => {
    const b = broker(range({ messages: [msg(1)], throughSeq: 1 }));
    const d = doc();
    const c = createPortableClient({
      call: b.call,
      principal: "acct",
      doc: d,
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    let heard = 0;
    const leave = c.subscribe(() => heard++);
    await turn();
    expect(heard).toBeGreaterThan(0);
    d.visibilityState = "hidden";
    d.fire();
    expect(c.get().live).toBe(false);
    const reads = b.seen.length;
    d.visibilityState = "visible";
    d.fire();
    await turn();
    expect(b.seen.length).toBeGreaterThan(reads);
    leave();
    const before = heard;
    c.send("x");
    expect(heard).toBe(before);
    c.stop();
    expect(c.send("after stop")).toBe(false);
  });

  test("a read failure shows the warning and the next visibility change reads again", async () => {
    let n = 0;
    const call: PortableCall = async (_i, _p, signal) => {
      n++;
      if (n === 1) throw new Error("network");
      if (n === 2)
        return { ok: true, kind: "history", range: range({ messages: [msg(1)], throughSeq: 1 }) };
      return new Promise((r) =>
        signal?.addEventListener("abort", () => r({ ok: false, error: "cancelled" })),
      );
    };
    const d = doc();
    const c = createPortableClient({
      call,
      principal: "acct",
      doc: d,
      busyLabel: "Li",
      failedLabel: "failed",
      onInvalidAccount() {},
    });
    await turn();
    expect(c.get().problem).toBe("failed");
    d.fire();
    await turn();
    expect(c.get().problem).toBeUndefined();
    expect(c.get().messages).toHaveLength(1);
    c.stop();
  });
});
