/**
 * The pure half of ./lanes-manager.ts (docs/lane-listen.md, "Every agent
 * joins"; owner, 2026-11-15 "全员入群"): which agents on this Mac join the
 * owner's chat, under which lane name, and what the manager does about each.
 * No spawning and no network here; tested in unit/lanes-manager.test.ts.
 *
 * An agent (a row of `ay ls --json --local`) joins when its working
 * directory is under a whitelisted repo (config lanes.repos: Lianki and the
 * repos it depends on). Its lane is its registered name (lanes.agents: the
 * end of its cwd, its cli), else `<repo>-<leaf>` (generatedLane: stable
 * across restarts; `-<cli>`, `-<pid>` only to break a tie). One API token = one
 * name = one lane: the owner makes each at /my/preferences#tokens and it sits
 * at ~/.config/lianki/lanes/<lane>.token; the manager never mints one, it
 * says once in the chat which names still wait for theirs.
 *
 * A resident lane (lanes.agents resident) gets a `lane-listen --all` of its
 * own: it hears every owner line live; scope "all" (tier ①) adds `--everyone`,
 * agents' lines too, scope "system" (tier ⓪) `--everyone --system`, the system
 * lines as well (and `--skip-owner` when its agent has its own
 * feed of his lines: wake false, 小克). Any other lane is a reader: no listener
 * process; when a line names it (lane-route.ts, with the joined lanes in the
 * table, or `#<repo>`), the manager hands that line to its agent with
 * `ay send <pid> --code alt-m`, and it gets a listener of its own (tier ②)
 * for lanes.wakeLiveMin minutes after the last line that named it
 * (withWakeLive). Each new lane greets once, with its own token.
 */
import {
  type LaneAgentDef,
  type LaneScope,
  type LanesConfig,
  hearsAll,
} from "../../lib/lanes-config";
import { LANE_NAME_RE } from "../../lib/lanes-config";
import { laneModeWord, tokensNeededText } from "../../packages/debug-chat/src/lane-events";
import { type ChatLaneDef, isLaneId } from "../../packages/debug-chat/src/voices";
import { routeLine } from "../../lib/lane-route";

/** One row of `ay ls --json --local`, as far as the manager reads it. */
export type AyAgent = {
  pid: number;
  cli: string;
  cwd: string;
  /** The process: "active" = alive. */
  status?: string;
  /** The turn: "active" (mid-turn), "idle", "needs_input"… */
  state?: string;
  /** Where ay writes everything the agent prints (`log_file`): its live output, for the busy ring. */
  logFile?: string;
};

/** `ay ls --json --local`'s rows (a list, or {local: [...]}); anything unreadable: none. */
export function parseAyList(raw: string): AyAgent[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : (v as { local?: unknown } | null)?.local;
  if (!Array.isArray(list)) return [];
  const out: AyAgent[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.pid !== "number" || typeof r.cli !== "string" || typeof r.cwd !== "string")
      continue;
    out.push({
      pid: r.pid,
      cli: r.cli,
      cwd: r.cwd,
      ...(typeof r.status === "string" ? { status: r.status } : {}),
      ...(typeof r.state === "string" ? { state: r.state } : {}),
      ...(typeof r.log_file === "string" && r.log_file.startsWith("/")
        ? { logFile: r.log_file }
        : {}),
    });
  }
  return out;
}

const parts = (p: string) => p.split("/").filter(Boolean);

/** The whitelisted repo a working directory is under: its first path part that is one, or null. */
export function repoOf(cwd: string, repos: readonly string[]): string | null {
  return parts(cwd).find((p) => repos.includes(p)) ?? null;
}

/** The registered agent this one is: its cwd ends with the row's cwd (whole parts), and its cli matches. */
export function registeredOf(a: AyAgent, agents: readonly LaneAgentDef[]): LaneAgentDef | null {
  const have = parts(a.cwd);
  for (const d of agents) {
    const want = parts(d.cwd);
    if (!want.length || want.length > have.length) continue;
    if (d.cli && d.cli !== a.cli) continue;
    if (want.every((w, i) => have[have.length - want.length + i] === w)) return d;
  }
  return null;
}

/**
 * The part of an agent's cwd that names it: `<x>` for `…/<repo>/tree/<x>`,
 * `agent` for a Claude worktree (`…/.claude/worktrees/agent-<id>`), `main`
 * for a bare checkout (`~/ws/<org>/<repo>`), else the directory's name.
 */
export function laneLeaf(cwd: string, repo: string): string {
  const ps = parts(cwd);
  const wt = ps.lastIndexOf("worktrees");
  if (wt > 0 && ps[wt - 1] === ".claude" && ps[wt + 1])
    return ps[wt + 1]!.startsWith("agent-") ? "agent" : ps[wt + 1]!;
  const r = ps.indexOf(repo);
  if (r < 0) return ps.at(-1) ?? "";
  if (ps[r + 1] === "tree" && ps[r + 2]) return ps[r + 2]!;
  return "main";
}

/**
 * `<repo>-<leaf>` (laneLeaf), plus `-<cli>` and then `-<pid>` only when
 * another agent would share the name (planLanes): stable across restarts, so
 * one token keeps serving it. Lowercase, a token name's characters, cut to
 * its 40 (the head gives way to the suffixes).
 */
export function generatedLane(
  repo: string,
  cwd: string,
  suffix: readonly (string | number)[] = [],
): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/-+$/, "");
  const tail = suffix.map((x) => `-${clean(String(x)) || "agent"}`).join("");
  const r = clean(repo) || "repo";
  const leaf = clean(laneLeaf(cwd, repo));
  const head = (leaf ? `${r}-${leaf}` : r).slice(0, Math.max(1, 40 - tail.length));
  return `${head}${tail}`.slice(0, 40);
}

/** An agent that joins: its lane, repo and mode. */
export type Planned = {
  pid: number;
  cli: string;
  cwd: string;
  repo: string;
  lane: string;
  resident: boolean;
  /** What its listener hears (lanes.agents scope): "all" adds agents' lines (--everyone), "system" the system lines too (--system). */
  scope: LaneScope;
  /** Woken by name when a line names it (lanes.agents wake, default true). */
  wake: boolean;
  /** May answer his lines that name nobody, briefly (lanes.agents answerUnnamed). */
  answerUnnamed: boolean;
  /** Mid-turn now (ay's `state`). */
  busy: boolean;
  /** ay's turn state as listed (`state`), and the agent's live output log (lanes-busy.ts). */
  state?: string;
  logFile?: string;
};

/**
 * The agents that join, in `ay` order: alive, under a whitelisted repo. Its
 * name: the lane a running lane-listen already delivers to it (`--deliver
 * <pid>`: its registered name today, a resident lane), else its registered
 * name (lanes.agents; the first agent that matches it), else generated
 * (`<repo>-<leaf>`, with `-<cli>`, then `-<pid>`, only to break a tie).
 */
export function planLanes(
  agents: readonly AyAgent[],
  cfg: Pick<LanesConfig, "repos" | "agents">,
  bound: ReadonlyMap<number, string> = new Map(),
): Planned[] {
  const live = agents.filter((a) => a.status === undefined || a.status === "active");
  const taken = new Set(live.map((a) => bound.get(a.pid)).filter((l): l is string => !!l));
  type Row = { a: AyAgent; repo: string; lane?: string; reg: LaneAgentDef | null; held: boolean };
  const rows: Row[] = [];
  for (const a of live) {
    const repo = repoOf(a.cwd, cfg.repos);
    if (!repo) continue;
    const held = bound.get(a.pid);
    if (held) {
      rows.push({ a, repo, lane: held, reg: null, held: true });
      continue;
    }
    const reg = registeredOf(a, cfg.agents);
    if (reg && LANE_NAME_RE.test(reg.lane) && !taken.has(reg.lane)) {
      taken.add(reg.lane);
      rows.push({ a, repo, lane: reg.lane, reg, held: false });
    } else rows.push({ a, repo, reg: null, held: false });
  }
  // Generated names: the plain one, then -<cli>, then -<pid>, while two agents share one.
  const gen = rows.filter((r) => !r.lane);
  const names = gen.map((r) => generatedLane(r.repo, r.a.cwd));
  for (const level of [1, 2]) {
    const all = [...taken, ...names];
    const count = (n: string) => all.filter((x) => x === n).length;
    const clash = names.map((n) => count(n) > 1);
    gen.forEach((r, i) => {
      if (clash[i])
        names[i] = generatedLane(r.repo, r.a.cwd, level === 1 ? [r.a.cli] : [r.a.cli, r.a.pid]);
    });
  }
  gen.forEach((r, i) => (r.lane = names[i]!));
  return rows.map(({ a, repo, lane, reg, held }) => ({
    pid: a.pid,
    cli: a.cli,
    cwd: a.cwd,
    repo,
    lane: lane!,
    // scope "all" / "system" (tier ① / ⓪) is live by definition.
    resident: held || !!reg?.resident || hearsAll(reg?.scope),
    scope: reg?.scope ?? "owner",
    wake: reg?.wake !== false,
    // Owner, 2026-11-15 23:09 JST: a live lane answers by relevance to its project,
    // not by being named; a row may still say false (listen only).
    answerUnnamed: reg?.answerUnnamed ?? (held || !!reg?.resident || hearsAll(reg?.scope)),
    busy: a.state === "active",
    ...(a.state ? { state: a.state } : {}),
    ...(a.logFile ? { logFile: a.logFile } : {}),
  }));
}

/** The lane table rows for the joined lanes the built-in table does not know (so the router addresses them). */
export function laneTableFor(
  planned: readonly Planned[],
  extra: readonly ChatLaneDef[] = [],
): ChatLaneDef[] {
  const rows: ChatLaneDef[] = [...extra];
  for (const p of planned)
    if (!isLaneId(p.lane) && !rows.some((r) => r.id === p.lane)) rows.push({ id: p.lane });
  return rows;
}

/**
 * `lane-listen` processes already running on this Mac (oxmgr's, a human's)
 * that this manager did not start, from `ps -axo pid=,command=`: each lane
 * and the agent pid it delivers to (`--deliver <pid>`), or null.
 */
export function externalListeners(
  ps: string,
  own: ReadonlySet<number> = new Set(),
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || own.has(Number(m[1]))) continue;
    const cmd = m[2]!;
    if (!/lane-listen(?:\.ts)?(?:\s|$)/.test(cmd)) continue;
    const as = /(?:--as|--lane)[ =](\S+)/.exec(cmd);
    if (!as) continue;
    const to = /--deliver[ =](\d+)(?:\s|$)/.exec(cmd);
    out.set(as[1]!, to ? Number(to[1]) : null);
  }
  return out;
}

/** The agents those listeners deliver to, by pid: their lane is taken as the agent's registered name. */
export function boundLanes(external: ReadonlyMap<string, number | null>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [lane, pid] of external) if (pid !== null && !out.has(pid)) out.set(pid, lane);
  return out;
}

/** What the manager keeps between runs (~/.config/lianki/lanes/manager-state.json). */
export type ManagerState = {
  /** Lanes that have said their greeting. */
  greeted: string[];
  /** The last "waiting for a token" list said in the chat (sorted, comma-joined). */
  missing?: string;
};

export type Action =
  | {
      type: "start-listener";
      lane: string;
      cwd: string;
      pid: number;
      /** Its agent CLI kind (`ay ls` cli), so the listener picks it among several agents in `cwd`. */
      cli: string;
      scope: LaneScope;
      /** Its agent has its own feed of his lines (wake: false): the listener skips them. */
      skipOwner: boolean;
      /** It may answer his unnamed lines (lanes.agents answerUnnamed): `--answer-unnamed`. */
      answerUnnamed: boolean;
    }
  | { type: "stop-listener"; lane: string }
  | { type: "greet"; lane: string; text: string }
  | { type: "left"; lane: string }
  | { type: "tokens-needed"; names: string[]; text: string };

/** What the decision sees of the world now. */
export type World = {
  planned: readonly Planned[];
  /** Lanes with a token file (or LIANKI_TOKEN set for them). */
  tokens: ReadonlySet<string>;
  /** Lanes whose listener this manager runs. */
  running: ReadonlySet<string>;
  /** Lanes a listener already serves that this manager did not start. */
  external: { has(lane: string): boolean };
};

/** The greeting, from config lanes.greeting (lanes.greetingAnswerUnnamed for a lane that answers unnamed lines: decide picks it). */
export function greeting(p: Planned, template: string, locale = "zh"): string {
  const mode =
    laneModeWord({ mode: p.resident ? "listener" : "reader", scope: p.scope }, locale) ?? "";
  return template
    .replaceAll("{name}", p.lane)
    .replaceAll("{repo}", p.repo)
    .replaceAll("{cli}", p.cli)
    .replaceAll("{mode}", mode);
}

/**
 * One pass: from what joined before (`prev`) and the world now, the actions
 * and the state after them. Idempotent: the same world twice gives no
 * actions the second time.
 */
export function decide(
  prev: readonly Planned[],
  w: World,
  state: ManagerState,
  cfg: Pick<LanesConfig, "greeting"> & Partial<Pick<LanesConfig, "greetingAnswerUnnamed">>,
  locale = "zh",
): { actions: Action[]; state: ManagerState } {
  const actions: Action[] = [];
  const now = new Set(w.planned.map((p) => p.lane));
  const greeted = new Set(state.greeted);
  // Gone: its listener stops, and the chat hears it left.
  for (const p of prev) {
    if (now.has(p.lane)) continue;
    if (w.running.has(p.lane)) actions.push({ type: "stop-listener", lane: p.lane });
    if (w.tokens.has(p.lane)) actions.push({ type: "left", lane: p.lane });
  }
  // A listener of ours whose lane is no longer resident or present.
  for (const lane of w.running)
    if (
      !w.planned.some((p) => p.lane === lane && p.resident) &&
      !actions.some((a) => a.type === "stop-listener" && a.lane === lane)
    )
      actions.push({ type: "stop-listener", lane });
  const missing: string[] = [];
  for (const p of w.planned) {
    if (!w.tokens.has(p.lane)) {
      missing.push(p.lane);
      continue;
    }
    if (p.resident && !w.running.has(p.lane) && !w.external.has(p.lane))
      actions.push({
        type: "start-listener",
        lane: p.lane,
        cwd: p.cwd,
        pid: p.pid,
        cli: p.cli,
        scope: p.scope,
        skipOwner: !p.wake,
        answerUnnamed: p.answerUnnamed,
      });
    if (!greeted.has(p.lane)) {
      const template =
        p.answerUnnamed && cfg.greetingAnswerUnnamed ? cfg.greetingAnswerUnnamed : cfg.greeting;
      actions.push({ type: "greet", lane: p.lane, text: greeting(p, template, locale) });
      greeted.add(p.lane);
    }
  }
  const key = [...missing].sort().join(",");
  if (missing.length && key !== state.missing)
    actions.push({
      type: "tokens-needed",
      names: [...missing].sort(),
      text: tokensNeededText([...missing].sort(), locale),
    });
  return {
    actions,
    state: { greeted: [...greeted], ...(key ? { missing: key } : {}) },
  };
}

/**
 * The readers a line wakes: an owner line in the owner thread that names
 * them (lane-route.ts, with laneTableFor's rows in force), `@<lane>` anywhere
 * in it, or `#<repo>` for every reader of that repo. Listeners hear it
 * themselves, and a lane with lanes.agents `wake: false` (小克: its own feed)
 * is never woken; both are left out.
 */
export function wakeTargets(
  l: { from: string; thread?: string; text: string },
  planned: readonly Planned[],
): Planned[] {
  if (l.from !== "owner" || (l.thread ?? "owner") !== "owner") return [];
  const readers = planned.filter((p) => !p.resident && p.wake);
  if (!readers.length) return [];
  const r = routeLine(l.text);
  const named = new Set(r.addressed ? r.lanes : []);
  const tags = new Set(
    [...l.text.matchAll(/#([A-Za-z0-9._-]{1,40})/g)].map((m) => m[1]!.toLowerCase()),
  );
  const text = l.text.toLowerCase();
  const at = (lane: string) => {
    const want = `@${lane.toLowerCase()}`;
    for (let i = text.indexOf(want); i >= 0; i = text.indexOf(want, i + 1))
      if (!/[\p{L}\p{N}._-]/u.test(text[i + want.length] ?? "")) return true;
    return false;
  };
  return readers.filter((p) => named.has(p.lane) || tags.has(p.repo.toLowerCase()) || at(p.lane));
}

/**
 * The plan with the lanes woken by name in the last lanes.wakeLiveMin minutes
 * made live (owner, 2026-11-15 15:44 JST): until `liveUntil`, a reader hears
 * his lines as a tier-② listener does; then it is a reader again.
 */
export function withWakeLive(
  planned: readonly Planned[],
  liveUntil: ReadonlyMap<string, number>,
  now: number,
): Planned[] {
  return planned.map((p) =>
    !p.resident && (liveUntil.get(p.lane) ?? 0) > now ? { ...p, resident: true } : p,
  );
}
