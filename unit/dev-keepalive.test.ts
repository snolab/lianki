import { afterEach, describe, expect, it } from "bun:test";
import { DEAD, PING, PONG, keepalive } from "@/scripts/dev/keepalive";
import { DebugHub, KEEPALIVE, type Socket, type Storage } from "@/workers/push/src/debug";

/** One interval, fired by hand; `t` is the clock. */
function clock() {
  let fn: (() => void) | null = null;
  const c = {
    t: 0,
    cleared: false,
    timers: {
      setInterval: (f: () => void) => {
        fn = f;
        return 1;
      },
      clearInterval: () => {
        c.cleared = true;
        fn = null;
      },
    },
    now: () => c.t,
    tick(ms: number) {
      c.t += ms;
      fn?.();
    },
  };
  return c;
}

function socket(readyState = 1) {
  return {
    readyState,
    sent: [] as string[],
    send(d: string) {
      this.sent.push(d);
    },
  };
}

describe("eval.ts chat keepalive", () => {
  it("pings the open socket, and stays alive while answered", () => {
    const c = clock();
    const ws = socket();
    const dead: string[] = [];
    const k = keepalive(ws, (w) => dead.push(w), { everyMs: 20, timers: c.timers, now: c.now });
    for (let i = 0; i < 5; i++) {
      c.tick(20);
      k.heard();
    }
    expect(ws.sent).toEqual(Array(5).fill(PING));
    expect(dead).toEqual([]);
  });

  it("a ping left unanswered by the next tick is a dead socket: onDead once, timer stopped", () => {
    const c = clock();
    const ws = socket();
    const dead: string[] = [];
    keepalive(ws, (w) => dead.push(w), { everyMs: 20, timers: c.timers, now: c.now });
    c.tick(20);
    c.tick(20);
    c.tick(20);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain("no answer");
    expect(c.cleared).toBe(true);
  });

  it("any message counts as an answer, not only the pong", () => {
    const c = clock();
    const dead: string[] = [];
    const k = keepalive(socket(), (w) => dead.push(w), {
      everyMs: 20,
      timers: c.timers,
      now: c.now,
    });
    c.tick(20);
    k.heard(); // e.g. a chat line arrived
    c.tick(20);
    expect(dead).toEqual([]);
  });

  it("a socket still connecting past openMs is dead; one closed without an event too", () => {
    const c = clock();
    const connecting = socket(0);
    const dead: string[] = [];
    keepalive(connecting, (w) => dead.push(w), {
      everyMs: 10,
      openMs: 30,
      timers: c.timers,
      now: c.now,
    });
    c.tick(10);
    c.tick(10);
    expect(dead).toEqual([]);
    c.tick(10);
    expect(dead[0]).toContain("not open");

    const c2 = clock();
    const closed = socket(3);
    const dead2: string[] = [];
    keepalive(closed, (w) => dead2.push(w), { everyMs: 10, timers: c2.timers, now: c2.now });
    c2.tick(10);
    expect(dead2[0]).toContain("closed");
  });

  it("stopped (the socket closed normally): never fires", () => {
    const c = clock();
    const dead: string[] = [];
    const k = keepalive(socket(), (w) => dead.push(w), {
      everyMs: 10,
      timers: c.timers,
      now: c.now,
    });
    k.stop();
    c.tick(10);
    c.tick(10);
    expect(dead).toEqual([]);
  });

  it("its close code is not one the grant rules act on", () => {
    expect(DEAD).toBe(4000);
  });
});

describe("DebugHub answers the keepalive ping", () => {
  const g = globalThis as { WebSocketRequestResponsePair?: unknown };
  const had = g.WebSocketRequestResponsePair;
  afterEach(() => {
    g.WebSocketRequestResponsePair = had;
  });
  const storage = {} as Storage;

  it("sets the runtime's auto-response (no wake-up) when there is one", () => {
    class Pair {
      constructor(
        public q: string,
        public r: string,
      ) {}
    }
    g.WebSocketRequestResponsePair = Pair;
    const set: unknown[] = [];
    new DebugHub({
      acceptWebSocket() {},
      getWebSockets: () => [],
      setWebSocketAutoResponse: (p) => set.push(p),
      storage,
    });
    expect(set).toEqual([new Pair(PING, PONG)]);
    expect(KEEPALIVE).toEqual({ ping: PING, pong: PONG });
  });

  it("answers a ping that reaches it anyway", async () => {
    g.WebSocketRequestResponsePair = undefined;
    const hub = new DebugHub({ acceptWebSocket() {}, getWebSockets: () => [], storage });
    const sent: string[] = [];
    const ws: Socket = {
      readyState: 1,
      send: (d) => sent.push(d),
      close() {},
      serializeAttachment() {},
      deserializeAttachment: () => null,
    };
    (hub as unknown as { checkIdle: () => Promise<void> }).checkIdle = async () => {};
    await hub.webSocketMessage(ws, PING);
    expect(sent).toEqual([PONG]);
  });
});
