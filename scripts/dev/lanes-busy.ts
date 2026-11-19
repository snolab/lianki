/**
 * Who is busy, live (owner, 2026-11-16 00:4x JST: "在干活的 agent 的头像上面给它一个…转圈圈的
 * 动画", "ay list 好像不是实时的"): the lanes manager (./lanes-manager.ts) tells the hub when a
 * lane's agent starts or ends a task, with that lane's own token ({op:"lane", busy}), and the
 * page turns a ring around its picture (PresenceStack.tsx BusyRing).
 *
 * The source is the agent's own live output: ay writes everything its agent prints to
 * `log_file` (`ay ls --json --local`). Output arriving = busy; no output for config
 * lanes.busyIdleSec = idle. That quiet timer is one timeout per lane, re-armed on each write,
 * not a poll. Each log is followed by `tail -f -n 0` (kqueue on macOS: it blocks until the file
 * grows). Not `fs.watch`: ay keeps the log open and writes to that descriptor, and neither
 * Node's nor Bun's fs.watch reports those writes on macOS (measured 2026-11-16: 0 events while
 * the log grew 839 KB).
 *
 * Fallback, when a follower cannot start or dies: ay's own states (`ay ls --watch --json
 * --local`, which the manager runs anyway for its re-list edges). That stream POLLS: ay looks
 * every 2 s (`--interval`), so a lane on it is up to 2 s late. active → busy; stuck → busy and
 * stuck; idle / needs_input / stopped → not busy.
 *
 * Only a change is sent: repeated writes while busy send nothing more. Effects are passed in
 * (BusyDeps); unit/lanes-busy.test.ts drives it with mocks.
 */

/** A follower of one log: `onData` on each write, `onEnd` when it stops. */
export type Follower = { close(): void };

export interface BusyDeps {
  /** Follow `path` for writes (default: `tail -f -n 0`). Throws when it cannot start. */
  follow(path: string, onData: () => void, onEnd: (why: string) => void): Follower;
  /** Tell the hub the lane's busy (its own token): {op:"lane", busy, stuck?}. */
  send(lane: string, busy: boolean, stuck: boolean): Promise<void> | void;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(h: unknown): void;
  log(v: Record<string, unknown>): void;
}

/** ay's turn states (`ay ls --watch --json` `state`). */
export const AY_STATES = ["active", "idle", "needs_input", "stuck", "stopped"] as const;
export type AyState = (typeof AY_STATES)[number];
const isAyState = (s: unknown): s is AyState => (AY_STATES as readonly unknown[]).includes(s);

/** One transition of `ay ls --watch --json --local` (NDJSON), or null. */
export function parseAyEvent(raw: string): { pid: number; state: AyState } | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.pid !== "number" || !isAyState(e.state)) return null;
  return { pid: e.pid, state: e.state };
}

/** What a state of ay means for the ring. */
export const busyOfAy = (s: AyState) => ({
  busy: s === "active" || s === "stuck",
  stuck: s === "stuck",
});

type LaneWatch = {
  pid: number;
  path?: string;
  follower?: Follower;
  /** On ay's states (no follower, or it failed). */
  fallback: boolean;
  timer?: unknown;
  /** A follower that stopped is tried again after this (doubling to a minute). */
  backoffMs: number;
  retry?: unknown;
  /** What the hub was last told (undefined: nothing yet). */
  sent?: { busy: boolean; stuck: boolean };
};

export function createBusyTracker(d: BusyDeps, o: { idleMs: number }) {
  const lanes = new Map<string, LaneWatch>();

  const tell = (lane: string, busy: boolean, stuck = false) => {
    const w = lanes.get(lane);
    if (!w) return;
    if (w.sent && w.sent.busy === busy && w.sent.stuck === stuck) return;
    w.sent = { busy, stuck };
    d.log({ type: "busy", lane, busy, ...(stuck ? { stuck } : {}) });
    void Promise.resolve(d.send(lane, busy, stuck)).catch(() => {});
  };

  /** The quiet timer: re-armed on each write; when it runs out the lane is idle. */
  const arm = (lane: string) => {
    const w = lanes.get(lane);
    if (!w) return;
    if (w.timer !== undefined) d.clearTimer(w.timer);
    w.timer = d.setTimer(o.idleMs, () => {
      const x = lanes.get(lane);
      if (!x || x !== w) return;
      x.timer = undefined;
      tell(lane, false);
    });
  };

  const unwatch = (w: LaneWatch) => {
    if (w.timer !== undefined) d.clearTimer(w.timer);
    w.timer = undefined;
    if (w.retry !== undefined) d.clearTimer(w.retry);
    w.retry = undefined;
    const f = w.follower;
    w.follower = undefined;
    f?.close();
  };

  const start = (lane: string, w: LaneWatch) => {
    if (!w.path) {
      w.fallback = true;
      return;
    }
    try {
      const f = d.follow(
        w.path,
        () => {
          if (lanes.get(lane) !== w || w.fallback) return;
          tell(lane, true);
          arm(lane);
        },
        (why) => {
          if (lanes.get(lane) !== w || w.follower !== f) return;
          // Its follower stopped: ay's states carry this lane until it is back.
          d.log({ type: "busy-fallback", lane, why, retryMs: w.backoffMs });
          unwatch(w);
          w.fallback = true;
          const wait = w.backoffMs;
          w.backoffMs = Math.min(w.backoffMs * 2, 60_000);
          w.retry = d.setTimer(wait, () => {
            w.retry = undefined;
            if (lanes.get(lane) === w) start(lane, w);
          });
        },
      );
      w.follower = f;
      w.fallback = false;
      // Nothing written within the window: idle (clears a ring left from before a restart).
      arm(lane);
    } catch (e) {
      d.log({ type: "busy-fallback", lane, why: String((e as Error)?.message ?? e) });
      w.fallback = true;
    }
  };

  return {
    /**
     * The lanes now (the manager's plan, on each re-list): followers start for new lanes (or a
     * new log, a restarted agent), stop for gone ones, and a gone lane that was busy is told idle.
     */
    sync(planned: readonly { lane: string; pid: number; logFile?: string; state?: string }[]) {
      const now = new Map(planned.map((p) => [p.lane, p]));
      for (const [lane, w] of [...lanes]) {
        const p = now.get(lane);
        if (p && p.pid === w.pid && p.logFile === w.path) continue;
        if (!p && w.sent?.busy) tell(lane, false);
        unwatch(w);
        lanes.delete(lane);
      }
      for (const p of planned) {
        if (lanes.has(p.lane)) continue;
        const w: LaneWatch = {
          pid: p.pid,
          ...(p.logFile ? { path: p.logFile } : {}),
          fallback: false,
          backoffMs: 1_000,
        };
        lanes.set(p.lane, w);
        start(p.lane, w);
      }
      // A lane on ay's states: what this re-list saw (ay's `state`), when it is known.
      for (const p of planned) {
        const w = lanes.get(p.lane);
        if (w?.fallback && isAyState(p.state)) {
          const b = busyOfAy(p.state);
          tell(p.lane, b.busy, b.stuck);
        }
      }
    },
    /** One line of `ay ls --watch --json --local`: used for the lanes on the fallback only. */
    ayLine(raw: string) {
      const e = parseAyEvent(raw);
      if (!e) return;
      for (const [lane, w] of lanes) {
        if (w.pid !== e.pid || !w.fallback) continue;
        const b = busyOfAy(e.state);
        tell(lane, b.busy, b.stuck);
      }
    },
    /** Stop following; every lane told busy is told idle (the manager is going away). */
    stop() {
      for (const [lane, w] of lanes) {
        if (w.sent?.busy) tell(lane, false);
        unwatch(w);
      }
      lanes.clear();
    },
    /** For tests and the log: each lane's mode and what was last sent. */
    snapshot: () =>
      Object.fromEntries(
        [...lanes].map(([lane, w]) => [
          lane,
          { fallback: w.fallback, following: !!w.follower, sent: w.sent },
        ]),
      ),
  };
}
