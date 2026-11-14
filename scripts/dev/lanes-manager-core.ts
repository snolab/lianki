/**
 * The lanes manager's loop (./lanes-manager.ts; docs/lane-listen.md, "Every
 * agent joins"), with everything it does to the world passed in (Deps), so
 * unit/lanes-manager.test.ts drives it with mocks. The decisions are pure
 * (./lanes-manager-lib.ts); this applies them: listeners started and
 * stopped, greetings and leaves posted with each lane's own token, the
 * missing-token line, the readers' wake hand-offs.
 */
import { join } from "node:path";
import type { LanesConfig } from "../../lib/lanes-config";
import { type ChatLaneDef, setLaneTable } from "../../packages/debug-chat/src/voices";
import { handoffBrief, lineOf } from "./lane-listen-lib";
import {
  type Action,
  type ManagerState,
  type Planned,
  boundLanes,
  decide,
  externalListeners,
  laneTableFor,
  parseAyList,
  planLanes,
  wakeTargets,
} from "./lanes-manager-lib";

/** A child the manager started (a lane's listener). */
export type Child = { pid: number; kill(): void; exited: Promise<number> };

export interface Deps {
  /** `ay ls --json --local`'s stdout ("" when it failed or timed out). */
  ayList(): Promise<string>;
  /** `ps -axo pid=,command=`'s stdout. */
  ps(): Promise<string>;
  /** A lane's token (never logged), or undefined. */
  token(lane: string): string | undefined;
  /** Start `lane-listen --as <lane> --cwd <cwd> --all` with the lane table in its env. */
  startListener(p: { lane: string; cwd: string; table: string }): Child;
  /** POST the hub's chat API with a lane's token: {ok, status}. */
  chat(token: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }>;
  /** Hand `body` to the agent `pid` now (`ay send <pid> --force --no-wait --code alt-m -`): its exit code. */
  wake(pid: number, body: string): Promise<number>;
  loadState(): ManagerState;
  saveState(s: ManagerState): void;
  log(v: Record<string, unknown>): void;
}

export type ManagerOpts = {
  /** The Lianki checkout whose scripts the hand-offs name. */
  repo: string;
  cfg: LanesConfig;
  /** The manager's own token's name (env LIANKI_LANES_MANAGER_LANE, default "lanes"). */
  managerLane: string;
  /** Extra rows of the lane table (env LIANKI_CHAT_LANES, the live chat.lanes copy). */
  extraTable?: readonly ChatLaneDef[];
  locale?: string;
  dryRun?: boolean;
};

export function createManager(d: Deps, o: ManagerOpts) {
  let planned: Planned[] = [];
  let state = d.loadState();
  const children = new Map<string, Child>();
  /** Readers already handed their first line (the hand-off names the rules once). */
  const briefed = new Set<string>();
  const seen = new Set<string>();

  const table = () => JSON.stringify(laneTableFor(planned, o.extraTable));

  async function run(a: Action): Promise<void> {
    const { type: action, ...rest } = a;
    d.log({ type: "action", action, ...rest, ...("text" in rest ? { text: undefined } : {}) });
    if (o.dryRun) return;
    switch (a.type) {
      case "start-listener": {
        const c = d.startListener({ lane: a.lane, cwd: a.cwd, table: table() });
        children.set(a.lane, c);
        void c.exited.then((code) => {
          if (children.get(a.lane) === c) children.delete(a.lane);
          d.log({ type: "listener-exit", lane: a.lane, code });
        });
        return;
      }
      case "stop-listener":
        children.get(a.lane)?.kill();
        children.delete(a.lane);
        return;
      case "greet":
      case "left": {
        const t = d.token(a.lane);
        if (!t) return;
        const r = await d.chat(
          t,
          a.type === "greet"
            ? { op: "say", text: a.text, quiet: true }
            : { op: "lane", state: "left" },
        );
        d.log({ type: a.type, lane: a.lane, ok: r.ok, status: r.status });
        return;
      }
      case "tokens-needed": {
        const t = d.token(o.managerLane);
        if (!t) {
          d.log({
            type: "tokens-needed",
            names: a.names,
            posted: false,
            why: `no token for ${o.managerLane}`,
          });
          return;
        }
        const r = await d.chat(t, { op: "say", text: a.text, quiet: true });
        d.log({ type: "tokens-needed", names: a.names, posted: r.ok, status: r.status });
      }
    }
  }

  return {
    /** One look at ay's agents: plan, decide, act. */
    async relist(): Promise<Action[]> {
      const raw = await d.ayList();
      // ay did not answer: keep what we have (an empty list would make every lane leave).
      if (!raw.trim()) return [];
      const own = new Set([...children.values()].map((c) => c.pid));
      const external = externalListeners(await d.ps(), own);
      const next = planLanes(parseAyList(raw), o.cfg, boundLanes(external));
      setLaneTable(laneTableFor(next, o.extraTable));
      const tokens = new Set(next.map((p) => p.lane).filter((l) => d.token(l)));
      for (const p of planned) if (d.token(p.lane)) tokens.add(p.lane);
      const r = decide(
        planned,
        {
          planned: next,
          tokens,
          running: new Set(children.keys()),
          external,
        },
        state,
        o.cfg,
        o.locale,
      );
      planned = next;
      for (const a of r.actions) await run(a);
      if (JSON.stringify(r.state) !== JSON.stringify(state)) {
        state = r.state;
        if (!o.dryRun) d.saveState(state);
      }
      return r.actions;
    },
    /** One line of the manager's reader socket (`lianki chat listen --json --reader`): wake the readers it names. */
    async line(raw: string): Promise<number[]> {
      const l = lineOf(raw);
      if (!l || l.history || seen.has(l.id)) return [];
      seen.add(l.id);
      const woken: number[] = [];
      for (const p of wakeTargets(l, planned)) {
        if (!d.token(p.lane)) continue;
        const body = handoffBrief(p.lane, [l], o.repo, !briefed.has(p.lane));
        briefed.add(p.lane);
        const code = o.dryRun ? 0 : await d.wake(p.pid, body);
        d.log({ type: "woken", lane: p.lane, pid: p.pid, id: l.id, ay: code });
        woken.push(p.pid);
      }
      return woken;
    },
    /** Stop every listener this manager started. */
    stop() {
      for (const c of children.values()) c.kill();
      children.clear();
    },
    planned: () => planned,
    running: () => [...children.keys()],
    state: () => state,
  };
}

/** The listener command for a lane (lane-listen through lianki-dev, every line, from the agent's dir). */
export const listenerArgv = (bun: string, repo: string, lane: string, cwd: string) => [
  bun,
  join(repo, "scripts", "dev", "lianki-dev.ts"),
  "lane-listen",
  "--repo",
  repo,
  "--as",
  lane,
  "--cwd",
  cwd,
  "--all",
];
