import { describe, expect, it } from "bun:test";
import {
  createMessageTelemetry,
  messageTelemetry,
  sampledMessage,
  type MessageTimingBatch,
} from "../packages/debug-chat/src/message-telemetry";

const setup = (capacity = 128) => {
  let time = 100;
  let seq = 0;
  const timers = new Map<number, () => void>();
  const logs: MessageTimingBatch[] = [];
  const telemetry = createMessageTelemetry({
    now: () => time,
    instanceId: () => "test-page",
    maxRecords: capacity,
    setTimer: (fn) => {
      timers.set(++seq, fn);
      return seq;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  telemetry.configure({ sampleRate: 1, flushMs: 1000, batchSize: 8, log: (e) => logs.push(e) });
  return {
    telemetry,
    logs,
    timers,
    at: (t: number) => {
      time = t;
    },
    run: () => {
      const todo = [...timers.values()];
      timers.clear();
      for (const fn of todo) fn();
    },
  };
};

describe("message timing", () => {
  it("keeps client send, receive, visible and actual speech timestamps distinct", () => {
    const s = setup();
    s.telemetry.sent({ id: "request-1", source: "typed", at: 80 });
    s.telemetry.received({ id: "request-1", from: "owner", at: 999999 });
    s.at(200);
    s.telemetry.received({ id: "reply-1", from: "agent", lane: "claude", at: 1 });
    s.at(250);
    s.telemetry.displayed("reply-1");
    s.at(300);
    s.telemetry.speech("reply-1", "start");
    s.at(700);
    s.telemetry.speech("reply-1", "end");
    expect(s.logs).toHaveLength(0);
    s.run();
    expect(s.logs).toEqual([
      {
        ev: "chat-message-timing",
        clock: "client",
        pageInstance: "test-page",
        records: [
          { id: "request-1", source: "typed", from: "owner", sentAt: 80, receivedAt: 100 },
          {
            id: "reply-1",
            from: "agent",
            lane: "claude",
            receivedAt: 200,
            displayedAt: 250,
            speechStartedAt: 300,
            speechEndedAt: 700,
            speechOutcome: "ended",
          },
        ],
      },
    ]);
    expect(s.telemetry.snapshot()[0]).not.toHaveProperty("replyMs");
  });

  it("ignores history and duplicate events rather than resetting first arrival", () => {
    const s = setup();
    s.telemetry.received({ id: "old", from: "agent" }, false);
    s.telemetry.displayed("old");
    s.telemetry.speech("old", "start");
    expect(s.telemetry.snapshot()).toEqual([]);
    s.telemetry.received({ id: "new", from: "agent" });
    s.telemetry.displayed("new");
    s.telemetry.sent({ id: "sent", source: "stt" });
    s.at(200);
    s.telemetry.received({ id: "new", from: "owner" });
    s.telemetry.displayed("new");
    s.telemetry.sent({ id: "sent", source: "typed" });
    expect(s.telemetry.snapshot()).toEqual([
      { id: "new", from: "agent", receivedAt: 100, displayedAt: 100 },
      { id: "sent", source: "stt", sentAt: 100 },
    ]);
  });

  it("does not turn cancellations/errors into completion through late callbacks", () => {
    for (const event of ["cancel", "error"] as const) {
      const s = setup();
      s.telemetry.received({ id: "reply", from: "agent" });
      s.telemetry.speech("reply", "end");
      s.telemetry.speech("reply", "start");
      s.at(200);
      s.telemetry.speech("reply", event);
      s.at(300);
      s.telemetry.speech("reply", "end");
      s.telemetry.speech("reply", "start");
      expect(s.telemetry.snapshot()).toEqual([
        {
          id: "reply",
          from: "agent",
          receivedAt: 100,
          speechStartedAt: 100,
          speechStoppedAt: 200,
          speechOutcome: event === "cancel" ? "cancelled" : "error",
        },
      ]);
    }
  });

  it("samples uploads consistently while retaining a bounded local snapshot", () => {
    const s = setup(2);
    s.telemetry.configure({ sampleRate: 0 });
    for (const id of ["a", "b", "c"]) s.telemetry.received({ id, from: "agent" });
    expect(s.telemetry.snapshot().map((r) => r.id)).toEqual(["b", "c"]);
    expect(s.timers.size).toBe(0);
    s.telemetry.flush();
    expect(s.logs).toEqual([]);
    expect(sampledMessage("same", 0.4)).toBe(sampledMessage("same", 0.4));
    expect(sampledMessage("same", 1)).toBe(true);
    expect(sampledMessage("same", 0)).toBe(false);
    expect(sampledMessage("same", NaN)).toBe(false);
  });

  it("records failures before sound starts without inventing an audible timestamp", () => {
    const s = setup();
    s.telemetry.received({ id: "failed", from: "agent" });
    s.telemetry.received({ id: "queued", from: "agent" });
    s.at(200);
    s.telemetry.speech("failed", "error");
    s.telemetry.speech("queued", "cancel");
    s.telemetry.speech("failed", "start");
    s.telemetry.speech("failed", "end");
    expect(s.telemetry.snapshot()).toEqual([
      {
        id: "failed",
        from: "agent",
        receivedAt: 100,
        speechStoppedAt: 200,
        speechOutcome: "error",
      },
      {
        id: "queued",
        from: "agent",
        receivedAt: 100,
        speechStoppedAt: 200,
        speechOutcome: "cancelled",
      },
    ]);
  });

  it("batches by threshold, bounds payloads, and rejects unsafe identifiers", () => {
    const s = setup();
    s.telemetry.configure({ batchSize: 32 });
    for (let i = 0; i < 32; i++)
      s.telemetry.received({
        id: "id-" + i + "-" + "x".repeat(120),
        from: "agent",
        lane: "声".repeat(64),
      });
    expect(s.logs.length).toBeGreaterThan(0);
    expect(s.logs.every((e) => JSON.stringify(e).length < 8192)).toBe(true);
    const start = s.telemetry.snapshot().length;
    for (const id of ["lk_secret", "url/secret", "mail@example.com", "bad\nvalue"])
      s.telemetry.displayed(id);
    expect(s.telemetry.snapshot()).toHaveLength(start);
    s.telemetry.received({ id: "safe", from: "agent", lane: "mail@example.com" });
    expect(s.telemetry.snapshot().at(-1)).not.toHaveProperty("lane");
  });

  it("clears timers and state when disabled and never schedules while disabled", () => {
    const s = setup();
    s.telemetry.received({ id: "x", from: "agent" });
    expect(s.telemetry.enabled()).toBe(true);
    expect(s.timers.size).toBe(1);
    s.telemetry.configure({ log: null });
    expect(s.telemetry.enabled()).toBe(false);
    expect(s.timers.size).toBe(0);
    expect(s.telemetry.snapshot()).toEqual([]);
    s.telemetry.received({ id: "disabled", from: "agent" });
    s.telemetry.flush();
    expect(s.telemetry.snapshot()).toEqual([]);
    expect(s.logs).toEqual([]);
  });

  it("ignores invalid clocks and keeps logging failures out of user flows", () => {
    const s = setup();
    s.telemetry.configure({
      flushMs: -1,
      batchSize: 1,
      log: () => {
        throw Error("unavailable");
      },
    });
    expect(() => s.telemetry.sent({ id: "x", source: "typed", at: Infinity })).not.toThrow();
    expect(() => s.telemetry.displayed("x")).not.toThrow();
    s.at(NaN);
    s.telemetry.received({ id: "y", from: "agent" });
    s.telemetry.speech("z", "start");
    expect(s.telemetry.snapshot().find((r) => r.id === "x")?.displayedAt).toBe(100);
  });

  it("reschedules a pending batch after configuration changes", () => {
    const s = setup();
    s.telemetry.received({ id: "x", from: "agent" });
    s.telemetry.configure({ flushMs: 300000 });
    expect(s.timers.size).toBe(1);
    s.run();
    expect(s.logs).toHaveLength(1);
  });

  it("shares the browser store and uses real one-shot timers without polling", async () => {
    const singleton = messageTelemetry();
    expect(messageTelemetry()).toBe(singleton);
    const s = createMessageTelemetry();
    const logs: MessageTimingBatch[] = [];
    s.configure({ sampleRate: 1, flushMs: 1, log: (e) => logs.push(e) });
    s.received({ id: "timer", from: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.records[0]?.receivedAt).toBeGreaterThan(0);
    s.configure({ log: null });
  });

  it("uses distinct ephemeral page instances, stable until disabled", () => {
    const one = createMessageTelemetry();
    const two = createMessageTelemetry();
    const logs: MessageTimingBatch[] = [];
    const config = { sampleRate: 1, batchSize: 1, log: (e: MessageTimingBatch) => logs.push(e) };
    one.configure(config);
    two.configure(config);
    one.received({ id: "one", from: "agent" });
    one.received({ id: "two", from: "agent" });
    two.received({ id: "one", from: "agent" });
    expect(logs[0]?.pageInstance).toBe(logs[1]?.pageInstance);
    expect(logs[0]?.pageInstance).not.toBe(logs[2]?.pageInstance);
    one.configure({ log: null });
    one.configure(config);
    one.received({ id: "one", from: "agent" });
    expect(logs[0]?.pageInstance).not.toBe(logs[3]?.pageInstance);
    one.configure({ log: null });
    two.configure({ log: null });
  });
});
