/**
 * A keepalive for a long-lived controller socket (`eval.ts chat`): a socket
 * that dies without a close event — the push Worker redeployed, the Durable
 * Object evicted, a NAT or the edge dropping the TCP connection — would
 * otherwise leave the listener alive but deaf, and the hub counting no
 * listener ("waiting for your Learning Partner").
 *
 * Every `everyMs` it sends PING on the open socket; the hub answers PONG by
 * the Durable Object's auto-response (workers/push/src/debug.ts), which does
 * not wake a hibernated hub. Anything heard counts as alive. A ping left
 * unanswered by the next tick, or a socket still connecting at a tick past
 * `openMs`, is dead: `onDead` runs once, and the caller drops it and reconnects.
 * This is a timer on the open socket, not polling an endpoint.
 * Unit-tested in unit/dev-keepalive.test.ts.
 */

export const PING = "ping";
export const PONG = "pong";
/** Close code for a socket given up on here (any 4xxx not used by the hub). */
export const DEAD = 4000;

export type KeepaliveSocket = {
  readonly readyState: number;
  send(data: string): void;
};

export type Timers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
};

const OPEN = 1;

export type Keepalive = {
  /** Call on every message from the socket (the pong included). */
  heard(): void;
  /** Stop the timer (the socket closed, or was replaced). */
  stop(): void;
};

export function keepalive(
  ws: KeepaliveSocket,
  onDead: (why: string) => void,
  {
    everyMs = 20_000,
    openMs = 20_000,
    timers = globalThis as unknown as Timers,
    now = Date.now,
  }: { everyMs?: number; openMs?: number; timers?: Timers; now?: () => number } = {},
): Keepalive {
  const started = now();
  let waiting = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(id);
  };
  const dead = (why: string) => {
    stop();
    onDead(why);
  };
  const tick = () => {
    if (stopped) return;
    if (ws.readyState !== OPEN) {
      if (ws.readyState > OPEN) return dead("socket closed without a close event");
      if (now() - started >= openMs) dead(`not open after ${Math.round(openMs / 1000)}s`);
      return;
    }
    if (waiting) return dead(`no answer to a ping in ${Math.round(everyMs / 1000)}s`);
    waiting = true;
    try {
      ws.send(PING);
    } catch (e) {
      dead(`ping failed: ${(e as Error).message}`);
    }
  };
  const id = timers.setInterval(tick, everyMs);
  return {
    heard() {
      waiting = false;
    },
    stop,
  };
}
