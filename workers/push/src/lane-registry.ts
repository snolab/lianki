/**
 * The lane registry (owner, 2026-11-15 "全员入群"; docs/lane-listen.md, "Every
 * agent joins"): for each lane (an API token's name, one token = one name =
 * one lane) in a thread, its mode, whether it is muted, and when it was last
 * seen. Held by DebugHub's storage, kept by TokenChat (token-chat.ts).
 *
 * Two identities:
 *   reader    a token that read or posted (HTTP read/say/ask, an MCP wait, a
 *             socket that said `mode: "reader"`): passive, not resident.
 *   listener  a token socket opened by `lianki chat listen` (auth without a
 *             mode, or `mode: "listener"`): resident, hears every line live.
 *             Its `scope` (auth `scope`, `lianki chat listen --everyone`):
 *             "all" when its agent is handed every line (agents' and system
 *             lines too, tier ①), else the owner's only (tier ②; absent =
 *             "owner", an older client). "X 开始实时监听（全部消息）" vs "X 开始实时监听".
 * A listener whose last socket closes becomes a reader after the grace
 * (config `lanes.modeGraceSec`), so a reconnect says nothing.
 * One lane, several sockets (the lanes manager's listener and a second feed
 * on the same token): the lane's mode and scope are those of all its live
 * sockets together (token-chat.ts passes the effective scope: "all" while any
 * live socket hears all). Only a change of the LANE is said: a second socket,
 * a reconnect in the grace, say nothing. Losing "all" (its last all-socket
 * closed, an owner-only one still open) is also graced (`scopeDownAt`) and
 * then dropped silently, since the lane still listens; an upgrade back to
 * "all" says "开始实时监听（全部消息）" once. `left`: the
 * manager said its agent exited (op "lane", state "left").
 * The main lane (Li; voices.ts LANES.main's names) is always a listener: it
 * is never downgraded, never leaves.
 *
 * Each change of mode, a first join, a leave and a mute posts one system line
 * (lane-events.ts) in the thread, quiet, `laneEvent` set; the presence list
 * carries the mode. Mute is enforced on say/ask (token-chat.ts: 403 "muted").
 * All of it only with flag `chat.lane-events` on (an older hub, or the flag
 * off: nothing here runs, and nothing changes for the lanes).
 *
 * The transitions are pure (laneStep); LaneRegistry applies them to storage.
 * Tested in unit/lane-registry.test.ts.
 */
import {
  type LaneEvent,
  type LaneEventKind,
  type LaneScope,
  laneEventText,
} from "../../../packages/debug-chat/src/lane-events";
import { laneOf } from "../../../packages/debug-chat/src/voices";
import type { ChatMessage } from "../../../packages/debug-chat/src/wire";

export type LaneState = "reader" | "listener" | "left";
export type LaneReg = {
  lane: string;
  thread: string;
  state: LaneState;
  /** A listener that hears every line (tier ①); absent: the owner's lines only. */
  scope?: "all";
  muted?: true;
  /** Its last verified use. */
  seenAt: number;
  /** When its state last changed. */
  changedAt: number;
  /** A listener whose sockets all closed: it turns reader at this time, unless one reopens. */
  downAt?: number;
  /** A listener with scope all whose all-sockets closed (an owner-only one still open): it drops to the owner's at this time, silently, unless one reopens. */
  scopeDownAt?: number;
  /** The name its lines were last shown with (the owner's for it, else its own), for the alarm's line. */
  name?: string;
};

export type LaneInput =
  | { type: "seen" }
  /** `scope`: the lane's effective scope over its live sockets (absent: keep the one it has); `graceMs`: how long a drop from all waits. */
  | { type: "listen"; scope?: LaneScope; graceMs?: number }
  | { type: "unlisten"; graceMs: number }
  | { type: "due" }
  | { type: "reader" }
  | { type: "leave" }
  | { type: "mute"; muted: boolean };

export const LANE_REG_PREFIX = "lanereg:";
export const laneRegKey = (thread: string, lane: string) => `${LANE_REG_PREFIX}${thread}:${lane}`;
/** The label and agent id of the hub's lane lines (never a lane, never the owner). */
export const LANE_EVENT_LABEL = "lanes";
export const LANE_EVENT_AGENT = "lanes";
export const LANE_EVENTS_FLAG = "chat.lane-events";
/** The reason a muted lane's say/ask gets (403 "muted"). */
export const MUTED_REASON =
  "this lane is muted by the owner: it may read and listen, not post (lane-registry.ts)";

/** Is this the main lane (Li)? Always a listener, never downgraded. */
export const isPinnedLane = (lane: string) => laneOf({ text: `【${lane}】` }).lane === "main";

/**
 * One input on a lane's row: the next row, the system line it posts (if
 * any), and when the hub must look at it again (a listener going down).
 */
export function laneStep(
  prev: LaneReg | undefined,
  input: LaneInput,
  ctx: { lane: string; thread: string; now: number },
): { next: LaneReg; event?: LaneEventKind; dueAt?: number } {
  const { now } = ctx;
  const pinned = isPinnedLane(ctx.lane);
  const base: LaneReg = prev ?? {
    lane: ctx.lane,
    thread: ctx.thread,
    state: "left",
    seenAt: now,
    changedAt: now,
  };
  const to = (state: LaneState, event?: LaneEventKind, scope?: LaneScope) => {
    const { downAt: _d, scope: _s, scopeDownAt: _sd, ...rest } = base;
    return {
      next: { ...rest, state, ...(scope === "all" ? { scope } : {}), seenAt: now, changedAt: now },
      event,
    };
  };
  switch (input.type) {
    case "seen":
      if (!prev || prev.state === "left")
        return pinned ? to("listener", "listening") : to("reader", "joined");
      return { next: { ...prev, seenAt: now } };
    case "listen": {
      if (prev?.state !== "listener") {
        const scope = input.scope ?? "owner";
        return to("listener", scope === "all" ? "listeningAll" : "listening", scope);
      }
      // Already live: a second socket, a reconnect in the grace. Only a change of scope counts.
      const { downAt: _d, scopeDownAt: _sd, ...rest } = prev;
      const had = prev.scope ?? "owner";
      // No scope (the alarm sees a socket again): the one it had, a pending drop kept.
      if (input.scope === undefined || (input.scope === had && had === "owner"))
        return {
          next: {
            ...rest,
            ...(prev.scopeDownAt ? { scopeDownAt: prev.scopeDownAt } : {}),
            seenAt: now,
          },
        };
      if (input.scope === "all")
        return had === "all"
          ? { next: { ...rest, seenAt: now } }
          : { next: { ...rest, scope: "all", seenAt: now, changedAt: now }, event: "listeningAll" };
      // all → owner: graced, then silent (it still listens).
      const grace = input.graceMs ?? 0;
      if (grace <= 0) {
        const { scope: _s, ...owner } = rest;
        return { next: { ...owner, seenAt: now, changedAt: now } };
      }
      const at = prev.scopeDownAt ?? now + grace;
      return { next: { ...rest, scopeDownAt: at, seenAt: now }, dueAt: at };
    }
    case "unlisten":
      if (prev?.state !== "listener" || pinned) return { next: prev ?? base };
      if (input.graceMs <= 0) return to("reader", "reader");
      return { next: { ...prev, downAt: now + input.graceMs }, dueAt: now + input.graceMs };
    case "due":
      if (prev?.state !== "listener") return { next: prev ?? base };
      if (prev.downAt !== undefined && prev.downAt <= now) return to("reader", "reader");
      if (prev.scopeDownAt !== undefined && prev.scopeDownAt <= now) {
        const { scope: _s, scopeDownAt: _sd, ...rest } = prev;
        return { next: { ...rest, changedAt: now } };
      }
      return { next: prev };
    case "reader":
      if (pinned || prev?.state === "reader") return { next: { ...(prev ?? base), seenAt: now } };
      return to("reader", prev?.state === "listener" ? "reader" : "joined");
    case "leave":
      if (pinned || !prev || prev.state === "left") return { next: prev ?? base };
      return to("left", "left");
    case "mute": {
      const was = prev?.muted === true;
      if (was === input.muted) return { next: prev ?? base };
      const { muted: _m, ...rest } = base;
      return {
        next: input.muted ? { ...rest, muted: true } : rest,
        event: input.muted ? "muted" : "unmuted",
      };
    }
  }
}

/** The system line for an event. */
export function laneEventLine(
  e: LaneEvent,
  thread: string,
  now: number,
  locale: string,
  id: string,
): ChatMessage & { thread: string } {
  return {
    id,
    from: "agent",
    label: LANE_EVENT_LABEL,
    text: laneEventText(e, locale),
    at: now,
    thread,
    agentId: LANE_EVENT_AGENT,
    quiet: true,
    laneEvent: e,
  };
}

export interface LaneHost {
  now(): number;
  kv: {
    get<T>(k: string): Promise<T | undefined>;
    put(k: string, v: unknown): Promise<void>;
    list?<T>(prefix: string): Promise<T[]>;
  };
  post(m: ChatMessage & { thread: string }): Promise<void>;
  /** Flag chat.lane-events (cached by the host); false when it cannot be read. */
  enabled(): Promise<boolean>;
  /** Config lanes.modeGraceSec, in ms. */
  graceMs(): Promise<number>;
  /** Config lanes.eventLocale. */
  locale(): Promise<string>;
  /** Wake the hub at `at` (its alarm), for a listener going down. */
  schedule(at: number): Promise<void>;
  /** The thread's presence changed. */
  presence?(thread: string): void;
}

export class LaneRegistry {
  constructor(private host: LaneHost) {}
  /** One input at a time per row: two sockets authing together must not both see "left". */
  private chains = new Map<string, Promise<unknown>>();

  /** Apply one input; post its line. `name`: how the line names the lane (the owner's name for it, else its own). */
  apply(thread: string, lane: string, input: LaneInput, name?: string): Promise<LaneReg | null> {
    const key = laneRegKey(thread, lane);
    const run = (this.chains.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.applyNow(key, thread, lane, input, name));
    this.chains.set(key, run);
    void run
      .finally(() => {
        if (this.chains.get(key) === run) this.chains.delete(key);
      })
      .catch(() => {});
    return run;
  }

  private async applyNow(
    key: string,
    thread: string,
    lane: string,
    input: LaneInput,
    name?: string,
  ): Promise<LaneReg | null> {
    if (!(await this.host.enabled())) return null;
    const prev = await this.host.kv.get<LaneReg>(key);
    const r = laneStep(prev, input, { lane, thread, now: this.host.now() });
    if (name && name !== lane && r.next.name !== name) r.next = { ...r.next, name };
    name ??= r.next.name ?? lane;
    if (r.next !== prev) await this.host.kv.put(key, r.next);
    if (r.dueAt !== undefined) await this.host.schedule(r.dueAt);
    if (r.event) {
      const line = laneEventLine(
        { lane, name, kind: r.event },
        thread,
        this.host.now(),
        await this.host.locale(),
        crypto.randomUUID().slice(0, 8),
      );
      await this.host.post(line);
      console.log(JSON.stringify({ msg: "debug.lane-event", lane, kind: r.event }));
    }
    if (r.event || (prev?.state ?? "left") !== r.next.state || prev?.scope !== r.next.scope)
      this.host.presence?.(thread);
    return r.next;
  }

  /** A socket of the lane listens: `scope` is the lane's effective one over its live sockets. */
  async listen(thread: string, lane: string, scope: LaneScope, name?: string) {
    return this.apply(
      thread,
      lane,
      { type: "listen", scope, graceMs: await this.host.graceMs() },
      name,
    );
  }

  /** A listener went down: its row, with the grace from config. */
  async unlisten(thread: string, lane: string, name?: string) {
    return this.apply(thread, lane, { type: "unlisten", graceMs: await this.host.graceMs() }, name);
  }

  /** The rows of one thread (all threads without one). */
  async list(thread?: string): Promise<LaneReg[]> {
    if (!this.host.kv.list) return [];
    const all = await this.host.kv.list<LaneReg>(
      thread === undefined ? LANE_REG_PREFIX : laneRegKey(thread, ""),
    );
    return all.filter((r) => thread === undefined || r.thread === thread);
  }

  /** Is this lane muted? (Without the flag nothing is.) */
  async muted(thread: string, lane: string): Promise<boolean> {
    if (!(await this.host.enabled())) return false;
    return (await this.host.kv.get<LaneReg>(laneRegKey(thread, lane)))?.muted === true;
  }

  /**
   * The alarm: listeners whose grace ran out turn reader (or drop from all to
   * the owner's), unless `live` says a socket of theirs is open again; `live`
   * gives the lane's effective scope, or true (scope unknown: keep it).
   */
  async sweep(live: (thread: string, lane: string) => boolean | LaneScope) {
    if (!(await this.host.enabled())) return;
    const t = this.host.now();
    for (let r of await this.list()) {
      if (r.state !== "listener" || (r.downAt === undefined && r.scopeDownAt === undefined))
        continue;
      const l = live(r.thread, r.lane);
      if (l) {
        const scope = l === true ? undefined : l;
        r =
          (await this.apply(r.thread, r.lane, {
            type: "listen",
            scope,
            graceMs: await this.host.graceMs(),
          })) ?? r;
      }
      const at = Math.min(r.downAt ?? Infinity, r.scopeDownAt ?? Infinity);
      if (at === Infinity) continue;
      if (at <= t) await this.apply(r.thread, r.lane, { type: "due" });
      else await this.host.schedule(at);
    }
  }
}
