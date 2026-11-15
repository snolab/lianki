// scripts/dev/lanes-manager*.ts (docs/lane-listen.md, "Every agent joins"):
// which agents join under which name, the manager's decisions, and its loop
// with every effect mocked (no ay, no network, no processes).
import { afterEach, describe, expect, it } from "bun:test";
import { LANES_CONFIG_DEFAULTS, laneAgentSchema, lanesConfig } from "@/lib/lanes-config";
import {
  type AyAgent,
  type Planned,
  boundLanes,
  decide,
  externalListeners,
  generatedLane,
  greeting,
  laneLeaf,
  laneTableFor,
  parseAyList,
  planLanes,
  registeredOf,
  repoOf,
  wakeTargets,
} from "@/scripts/dev/lanes-manager-lib";
import {
  type Child,
  type Deps,
  createManager,
  listenerArgv,
} from "@/scripts/dev/lanes-manager-core";
import { setLaneTable } from "@/packages/debug-chat/src/voices";

afterEach(() => void setLaneTable([]));

const W = "/Users/x/ws";
const AGENTS: AyAgent[] = [
  { pid: 5468, cli: "agy", cwd: `${W}/snolab/lianki/tree/agy`, status: "active", state: "active" },
  {
    pid: 64893,
    cli: "codex",
    cwd: `${W}/snolab/lianki/tree/coco-ui`,
    status: "active",
    state: "idle",
  },
  {
    pid: 52435,
    cli: "codex",
    cwd: `${W}/snolab/lianki/tree/codex`,
    status: "active",
    state: "idle",
  },
  {
    pid: 38876,
    cli: "codex",
    cwd: `${W}/snolab/lianki/tree/main/.claude/worktrees/agent-a6`,
    status: "active",
  },
  { pid: 71565, cli: "codex", cwd: `${W}/snomiao/rechrome/tree/main`, status: "active" },
  { pid: 54765, cli: "codex", cwd: `${W}/snolab/liagent`, status: "active" },
  { pid: 99422, cli: "codex", cwd: `${W}/snomiao/slack-term/tree/main`, status: "active" },
  { pid: 79001, cli: "claude", cwd: "/Users/x", status: "active" },
  { pid: 1, cli: "codex", cwd: `${W}/snomiao/otoji/tree/main`, status: "exited" },
];
const CFG = lanesConfig({});

describe("config", () => {
  it("defaults, and env values that check out", () => {
    expect(CFG).toEqual({
      repos: [...LANES_CONFIG_DEFAULTS["lanes.repos"]],
      agents: [...LANES_CONFIG_DEFAULTS["lanes.agents"]],
      relistSec: 60,
      forwardUnknownVoice: false,
      wakeLiveMin: 5,
      greeting: LANES_CONFIG_DEFAULTS["lanes.greeting"],
      greetingAnswerUnnamed: LANES_CONFIG_DEFAULTS["lanes.greetingAnswerUnnamed"],
    });
    const c = lanesConfig({
      LIANKI_LANES_REPOS: "lianki, foo ,bad repo",
      LIANKI_LANES_AGENTS: JSON.stringify([{ cwd: "foo/main", lane: "foo" }]),
      LIANKI_LANES_RELIST_SEC: "120",
      LIANKI_LANES_GREETING: "hi {name}",
      LIANKI_LANES_GREETING_ANSWER_UNNAMED: "yo {name}",
      LIANKI_LANES_FORWARD_UNKNOWN_VOICE: "true",
      LIANKI_LANES_WAKE_LIVE_MIN: "0",
    });
    expect(c).toEqual({
      repos: ["lianki", "foo"],
      agents: [{ cwd: "foo/main", lane: "foo" }],
      relistSec: 120,
      forwardUnknownVoice: true,
      wakeLiveMin: 0,
      greeting: "hi {name}",
      greetingAnswerUnnamed: "yo {name}",
    });
    const bad = lanesConfig({
      LIANKI_LANES_REPOS: " ,",
      LIANKI_LANES_AGENTS: "{nope",
      LIANKI_LANES_RELIST_SEC: "5",
      LIANKI_LANES_GREETING: "x".repeat(201),
      LIANKI_LANES_GREETING_ANSWER_UNNAMED: "x".repeat(201),
      LIANKI_LANES_FORWARD_UNKNOWN_VOICE: "maybe",
      LIANKI_LANES_WAKE_LIVE_MIN: "1.5",
    });
    expect(bad).toEqual(CFG);
    expect(lanesConfig({ LIANKI_LANES_FORWARD_UNKNOWN_VOICE: "0" }).forwardUnknownVoice).toBe(
      false,
    );
    expect(lanesConfig({ LIANKI_LANES_WAKE_LIVE_MIN: " " }).wakeLiveMin).toBe(5);
    expect(lanesConfig({ LIANKI_LANES_WAKE_LIVE_MIN: "241" }).wakeLiveMin).toBe(5);
    expect(
      lanesConfig({ LIANKI_LANES_AGENTS: JSON.stringify([{ cwd: "a", lane: "has space" }]) })
        .agents,
    ).toEqual(CFG.agents);
    const quiet = [{ cwd: "x/tree/y", cli: "claude", lane: "y", wake: false }];
    expect(lanesConfig({ LIANKI_LANES_AGENTS: JSON.stringify(quiet) }).agents).toEqual(quiet);
    expect(laneAgentSchema.safeParse({ cwd: "a", lane: "a", wake: "no" }).success).toBe(false);
    expect(CFG.agents).toContainEqual({
      cwd: "lianki/tree/agy",
      cli: "claude",
      lane: "claude",
      wake: false,
      scope: "all",
      answerUnnamed: false,
    });
    // coco and 小克 hear every line by default (tier ①, owner 2026-11-15 15:44 JST); the others his lines.
    expect(CFG.agents.filter((a) => a.scope === "all").map((a) => a.lane)).toEqual([
      "codex",
      "claude",
    ]);
    expect(CFG.agents.find((a) => a.lane === "codex")).toEqual({
      cwd: "lianki/tree/codex",
      cli: "codex",
      lane: "codex",
      resident: true,
      scope: "all",
      answerUnnamed: true,
    });
    // coco, 杰咪 and mimiai may answer his unnamed lines (owner, 2026-11-15 22:55 and 23:08 JST); the read-only ones never.
    expect(CFG.agents.filter((a) => a.answerUnnamed).map((a) => a.lane)).toEqual([
      "codex",
      "agy",
      "mimiai",
    ]);
    expect(laneAgentSchema.safeParse({ cwd: "a", lane: "a", answerUnnamed: true }).success).toBe(
      true,
    );
    expect(laneAgentSchema.safeParse({ cwd: "a", lane: "a", answerUnnamed: "yes" }).success).toBe(
      false,
    );
    expect(laneAgentSchema.safeParse({ cwd: "a", lane: "a", scope: "all" }).success).toBe(true);
    expect(laneAgentSchema.safeParse({ cwd: "a", lane: "a", scope: "owner" }).success).toBe(true);
    expect(laneAgentSchema.safeParse({ cwd: "a", lane: "a", scope: "some" }).success).toBe(false);
  });
});

describe("agent → lane", () => {
  it("reads ay's rows (a list or {local}), skips broken ones", () => {
    expect(parseAyList("nope")).toEqual([]);
    expect(parseAyList("{}")).toEqual([]);
    expect(
      parseAyList(
        JSON.stringify({
          local: [{ pid: 1, cli: "codex", cwd: "/a", status: "active" }, { pid: "x" }, null],
        }),
      ),
    ).toEqual([{ pid: 1, cli: "codex", cwd: "/a", status: "active" }]);
    expect(parseAyList(JSON.stringify([{ pid: 2, cli: "agy", cwd: "/b", state: "idle" }]))).toEqual(
      [{ pid: 2, cli: "agy", cwd: "/b", state: "idle" }],
    );
  });
  it("the repo: the first path part on the whitelist", () => {
    expect(repoOf(`${W}/snolab/lianki/tree/main/.claude/worktrees/x`, CFG.repos)).toBe("lianki");
    expect(repoOf(`${W}/snomiao/agent-yes/tree/ay-pagelink`, CFG.repos)).toBe("agent-yes");
    expect(repoOf(`${W}/snomiao/slack-term/tree/main`, CFG.repos)).toBeNull();
    expect(repoOf("/Users/x", CFG.repos)).toBeNull();
  });
  it("a registered agent: its cwd's end in whole parts, its cli", () => {
    const a = AGENTS[2]!;
    expect(registeredOf(a, CFG.agents)?.lane).toBe("codex");
    expect(registeredOf({ ...a, cli: "claude" }, CFG.agents)).toBeNull();
    expect(registeredOf({ ...a, cwd: `${W}/snolab/lianki/tree/xcodex` }, CFG.agents)).toBeNull();
    expect(registeredOf(a, [{ cwd: "", lane: "x" }])).toBeNull();
    expect(registeredOf({ ...a, cwd: "/codex" }, CFG.agents)).toBeNull();
  });
  it("the leaf: tree/<x>, a Claude worktree, a bare checkout, else the directory", () => {
    expect(laneLeaf(`${W}/snolab/lianki/tree/codex`, "lianki")).toBe("codex");
    expect(laneLeaf(`${W}/snolab/lianki/tree/main/.claude/worktrees/agent-a6`, "lianki")).toBe(
      "agent",
    );
    expect(laneLeaf(`${W}/snolab/lianki/.claude/worktrees/fix-x`, "lianki")).toBe("fix-x");
    expect(laneLeaf(`${W}/snolab/liagent`, "liagent")).toBe("main");
    expect(laneLeaf(`${W}/snolab/liagent/src`, "liagent")).toBe("main");
    expect(laneLeaf(`${W}/snolab/lianki/tree`, "lianki")).toBe("main");
    expect(laneLeaf("/private/tmp/coco-upload-bubble", "lianki")).toBe("coco-upload-bubble");
    expect(laneLeaf("/", "lianki")).toBe("");
  });
  it("generated names: <repo>-<leaf>, lowercase, token characters, 40 at most", () => {
    expect(generatedLane("rechrome", `${W}/snomiao/rechrome/tree/main`)).toBe("rechrome-main");
    expect(generatedLane("lianki", "/private/tmp/coco-upload-bubble")).toBe(
      "lianki-coco-upload-bubble",
    );
    expect(generatedLane("lianki", `${W}/snolab/lianki/tree/Coco UI!`)).toBe("lianki-coco-ui");
    expect(generatedLane("rechrome", `${W}/r/tree/x`, ["codex", 71565])).toBe(
      "rechrome-x-codex-71565",
    );
    const long = generatedLane(
      "a-very-long-repository-name-indeed-yes",
      "/w/a-very-long-repository-name-indeed-yes/tree/branch",
      ["claude", 1234567],
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-claude-1234567")).toBe(true);
    expect(generatedLane("..", "/", ["", 3])).toBe("repo-agent-3");
  });
  it("plans: whitelisted and alive only; a lane a listener delivers to wins; registered next", () => {
    const bound = new Map([
      [64893, "codex"],
      [5468, "agy"],
    ]);
    const p = planLanes(AGENTS, CFG, bound);
    expect(p.map((x) => [x.pid, x.lane, x.resident])).toEqual([
      [5468, "agy", true],
      [64893, "codex", true],
      // Registered as codex, but codex is bound to 64893: a name of its own.
      [52435, "lianki-codex", false],
      [38876, "lianki-agent", false],
      [71565, "rechrome-main", false],
      [54765, "liagent-main", false],
    ]);
    expect(p[0]!.busy).toBe(true);
    expect(p.every((x) => x.wake)).toBe(true);
    // A live lane answers by relevance to its project (owner, 2026-11-15 23:09 JST): on by
    // default for held and resident lanes; a row's explicit false keeps it listen-only.
    expect(p.every((x) => x.answerUnnamed === x.resident)).toBe(true);
    // Without listeners: the registered names (resident), the first agent that matches.
    const q = planLanes(AGENTS, CFG);
    expect(q.find((x) => x.pid === 52435)).toMatchObject({
      lane: "codex",
      resident: true,
      answerUnnamed: true,
    });
    expect(q.find((x) => x.pid === 5468)).toMatchObject({ lane: "agy", answerUnnamed: true });
    expect(q.find((x) => x.pid === 71565)).toMatchObject({ answerUnnamed: false });
    expect(q.find((x) => x.pid === 64893)).toMatchObject({
      lane: "lianki-coco-ui",
      resident: false,
    });
    // Two agents registered under one name: the second is generated.
    const twice = planLanes([AGENTS[2]!, { ...AGENTS[2]!, pid: 7 }], CFG);
    expect(twice.map((x) => x.lane)).toEqual(["codex", "lianki-codex"]);
    // A registered name that is not a token name falls back.
    expect(
      planLanes([AGENTS[2]!], { ...CFG, agents: [{ cwd: "codex", lane: "bad name" }] })[0]!.lane,
    ).toBe("lianki-codex");
  });
  it("小克 (claude in tree/agy) joins as claude, live on every line (scope all), never woken", () => {
    const k = { pid: 77, cli: "claude", cwd: `${W}/snolab/lianki/tree/agy`, status: "active" };
    const p = planLanes([AGENTS[0]!, k], CFG);
    expect(p.map((x) => [x.lane, x.resident, x.wake, x.scope])).toEqual([
      ["agy", true, true, "owner"],
      ["claude", true, false, "all"],
    ]);
    setLaneTable(laneTableFor(p));
    expect(wakeTargets({ from: "owner", text: "全体，集合" }, p)).toEqual([]);
    expect(wakeTargets({ from: "owner", text: "#lianki 看一下" }, p)).toEqual([]);
  });
  it("a tie: -<cli> first, -<pid> only if still tied", () => {
    const at = (pid: number, cli: string, cwd: string): AyAgent => ({ pid, cli, cwd });
    const two = planLanes(
      [at(1, "codex", `${W}/l/lianki/tree/x`), at(2, "claude", `${W}/l/lianki/tree/x`)],
      CFG,
    );
    expect(two.map((x) => x.lane)).toEqual(["lianki-x-codex", "lianki-x-claude"]);
    const same = planLanes(
      [
        at(1, "codex", `${W}/l/lianki/tree/x`),
        at(2, "codex", `${W}/l/lianki/tree/x`),
        at(3, "claude", `${W}/l/lianki/tree/x`),
        at(4, "codex", `${W}/l/lianki/tree/y`),
      ],
      CFG,
    );
    expect(same.map((x) => x.lane)).toEqual([
      "lianki-x-codex-1",
      "lianki-x-codex-2",
      "lianki-x-claude",
      "lianki-y",
    ]);
    // A generated name that a registered lane already holds gives way too.
    const held = planLanes(
      [at(9, "agy", `${W}/l/lianki/tree/z`), at(1, "codex", `${W}/l/lianki/tree/x`)],
      { ...CFG, agents: [{ cwd: "tree/z", lane: "lianki-x" }] },
    );
    expect(held.map((x) => x.lane)).toEqual(["lianki-x", "lianki-x-codex"]);
  });
  it("the lane table: the joined lanes the built-ins do not know", () => {
    const p = planLanes(AGENTS, CFG, new Map([[64893, "codex"]]));
    const t = laneTableFor(p, [{ id: "rechrome-main", name: "小镀" }]);
    expect(t[0]).toEqual({ id: "rechrome-main", name: "小镀" });
    expect(t.map((r) => r.id)).not.toContain("codex");
    expect(t.map((r) => r.id)).toContain("lianki-agent");
    expect(t.filter((r) => r.id === "rechrome-main")).toHaveLength(1);
  });
  it("finds running lane-listens and whom they deliver to", () => {
    const ps = [
      " 3257 bun /r/scripts/dev/lane-listen.ts --repo /r --as codex --cwd /r --deliver 64893 --all",
      " 7906 bun /r/scripts/dev/lane-listen.ts --repo /r --as agy --cwd /r",
      " 8000 bun /r/scripts/dev/lane-listen.ts --repo /r --as=mine --deliver=12",
      " 9000 vim lane-listen-lib.ts",
      " 9001 bun lane-listen.ts --repo /r",
      "garbage",
    ].join("\n");
    const e = externalListeners(ps, new Set([8000]));
    expect([...e]).toEqual([
      ["codex", 64893],
      ["agy", null],
    ]);
    expect([...boundLanes(e)]).toEqual([[64893, "codex"]]);
    expect([
      ...boundLanes(
        new Map([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ]).toEqual([[1, "a"]]);
  });
});

const plan = (lane: string, extra: Partial<Planned> = {}): Planned => ({
  pid: 1,
  cli: "codex",
  cwd: "/w/lianki/tree/x",
  repo: "lianki",
  lane,
  resident: false,
  scope: "owner",
  wake: true,
  answerUnnamed: false,
  busy: false,
  ...extra,
});

describe("decide", () => {
  const cfg = { greeting: CFG.greeting };
  it("greets once, starts resident listeners, says once who waits for a token", () => {
    const planned = [
      plan("codex", { resident: true, cwd: "/c", pid: 9 }),
      plan("rechrome-codex-2", { repo: "rechrome" }),
      plan("x-codex-3"),
    ];
    const w = {
      planned,
      tokens: new Set(["codex", "rechrome-codex-2"]),
      running: new Set<string>(),
      external: new Set<string>(),
    };
    const r = decide([], w, { greeted: [] }, cfg);
    expect(r.actions).toEqual([
      {
        type: "start-listener",
        lane: "codex",
        cwd: "/c",
        pid: 9,
        cli: "codex",
        scope: "owner",
        skipOwner: false,
        answerUnnamed: false,
      },
      {
        type: "greet",
        lane: "codex",
        text: "大家好，我是 codex（lianki · codex），实时监听入群。只回答点名我或「全体」的话。",
      },
      {
        type: "greet",
        lane: "rechrome-codex-2",
        text: "大家好，我是 rechrome-codex-2（rechrome · codex），只读入群。只回答点名我或「全体」的话。",
      },
      {
        type: "tokens-needed",
        names: ["x-codex-3"],
        text: "还在等 token 才能入群：x-codex-3（偏好设置 → API tokens）",
      },
    ]);
    expect(r.state).toEqual({ greeted: ["codex", "rechrome-codex-2"], missing: "x-codex-3" });
    // The same world again: nothing to do (its listener now runs).
    const again = decide(planned, { ...w, running: new Set(["codex"]) }, r.state, cfg);
    expect(again.actions).toEqual([]);
    // A listener someone else runs: not started twice.
    expect(decide([], { ...w, external: new Set(["codex"]) }, r.state, cfg).actions).toEqual([]);
  });
  it("an agent gone: its listener stops, its lane leaves; a lane no longer resident stops too", () => {
    const prev = [plan("codex", { resident: true }), plan("r-codex-2"), plan("n-codex-4")];
    const w = {
      planned: [plan("codex")],
      tokens: new Set(["codex", "r-codex-2"]),
      running: new Set(["codex", "old"]),
      external: new Set<string>(),
    };
    const r = decide(prev, w, { greeted: ["codex"] }, cfg);
    expect(r.actions).toEqual([
      { type: "left", lane: "r-codex-2" },
      { type: "stop-listener", lane: "codex" },
      { type: "stop-listener", lane: "old" },
    ]);
    // Gone while its listener runs.
    expect(
      decide(
        [plan("g", { resident: true })],
        {
          planned: [],
          tokens: new Set(["g"]),
          running: new Set(["g"]),
          external: new Set<string>(),
        },
        { greeted: [] },
        cfg,
      ).actions,
    ).toEqual([
      { type: "stop-listener", lane: "g" },
      { type: "left", lane: "g" },
    ]);
    // Everyone has a token now: the missing line is cleared from the state.
    expect(
      decide(
        [],
        {
          planned: [],
          tokens: new Set<string>(),
          running: new Set<string>(),
          external: new Set<string>(),
        },
        { greeted: [], missing: "a" },
        cfg,
      ).state,
    ).toEqual({ greeted: [] });
  });
  it("the greeting template", () => {
    expect(greeting(plan("a", { resident: true }), "{name}/{repo}/{cli}/{mode}", "en")).toBe(
      "a/lianki/codex/listening live",
    );
  });
});

describe("wakeTargets: readers named in his line", () => {
  it("by name (with the joined lanes in the table), #repo, 全体; never a listener, never another thread", () => {
    const planned = [
      plan("codex", { resident: true }),
      plan("rechrome-codex-2", { repo: "rechrome", pid: 2 }),
      plan("otoji-codex-3", { repo: "otoji", pid: 3 }),
    ];
    setLaneTable(laneTableFor(planned));
    const on = (text: string, extra = {}) =>
      wakeTargets({ from: "owner", text, ...extra }, planned).map((p) => p.pid);
    expect(on("rechrome-codex-2，看一下")).toEqual([2]);
    expect(on("#otoji 的 bug 谁看一下")).toEqual([3]);
    expect(on("全体，集合")).toEqual([2, 3]);
    expect(on("coco，看一下")).toEqual([]);
    expect(on("随便说说")).toEqual([]);
    // @<lane> anywhere in the line, a whole name only.
    expect(on("这个问题 @otoji-codex-3 看一下")).toEqual([3]);
    expect(on("这个问题 @OTOJI-codex-3")).toEqual([3]);
    expect(on("这个问题 @otoji-codex-33 看一下")).toEqual([]);
    expect(on("rechrome-codex-2，看一下", { thread: "uFriend" })).toEqual([]);
    expect(wakeTargets({ from: "agent", text: "rechrome-codex-2，看一下" }, planned)).toEqual([]);
    expect(
      wakeTargets({ from: "owner", text: "全体" }, [plan("codex", { resident: true })]),
    ).toEqual([]);
  });
});

describe("the loop (createManager), every effect mocked", () => {
  function setup(
    o: {
      tokens?: string[];
      ay?: AyAgent[];
      ps?: string;
      dryRun?: boolean;
      ayRaw?: string;
      cfg?: typeof CFG;
    } = {},
  ) {
    const calls: {
      chat: unknown[];
      wake: [number, string][];
      started: string[];
      killed: string[];
      saved: unknown[];
      logs: Record<string, unknown>[];
    } = {
      chat: [],
      wake: [],
      started: [],
      killed: [],
      saved: [],
      logs: [],
    };
    const tokens = new Set(o.tokens ?? ["agy", "codex", "rechrome-main", "lanes"]);
    const exits: ((c: number) => void)[] = [];
    let ay = o.ayRaw ?? JSON.stringify(o.ay ?? AGENTS);
    let pid = 100;
    const clock = { t: 1_000_000 };
    const timers: [number, () => void][] = [];
    const d: Deps = {
      now: () => clock.t,
      later: (ms, fn) => void timers.push([clock.t + ms, fn]),
      ayList: async () => ay,
      ps: async () => o.ps ?? " 7906 bun lane-listen.ts --as agy --deliver 5468",
      token: (lane) => (tokens.has(lane) ? `lk_${lane}` : undefined),
      startListener: ({ lane, table, scope, skipOwner, answerUnnamed }): Child => {
        calls.started.push(
          `${lane}${scope === "all" ? ":all" : ""}${skipOwner ? ":skip" : ""}${answerUnnamed ? ":unnamed" : ""}`,
        );
        expect(JSON.parse(table)).toBeArray();
        return {
          pid: pid++,
          kill: () => void calls.killed.push(lane),
          exited: new Promise<number>((r) => exits.push(r)),
        };
      },
      chat: async (token, body) => {
        calls.chat.push({ token, ...body });
        return { ok: true, status: 200 };
      },
      wake: async (p, body) => {
        calls.wake.push([p, body]);
        return 0;
      },
      loadState: () => ({ greeted: ["agy"] }),
      saveState: (s) => void calls.saved.push(s),
      log: (v) => void calls.logs.push(v),
    };
    const m = createManager(d, {
      repo: "/repo",
      cfg: o.cfg ?? CFG,
      managerLane: "lanes",
      dryRun: o.dryRun,
    });
    /** Move the clock and fire the timers that are due. */
    const advance = async (ms: number) => {
      clock.t += ms;
      const due = timers.filter(([at]) => at <= clock.t);
      timers.splice(0, timers.length, ...timers.filter(([at]) => at > clock.t));
      for (const [, fn] of due) fn();
      await Bun.sleep(1);
    };
    return { m, calls, exits, setAy: (a: AyAgent[]) => (ay = JSON.stringify(a)), tokens, advance };
  }

  it("relist: plans, starts the resident listener it lacks, greets once, posts the missing tokens", async () => {
    const s = setup();
    const acts = await s.m.relist();
    expect(acts.map((a) => a.type)).toEqual(["start-listener", "greet", "greet", "tokens-needed"]);
    // agy is served by the oxmgr listener; codex (tree/codex, registered) gets ours.
    expect(s.calls.started).toEqual(["codex:all:unnamed"]);
    expect(s.m.running()).toEqual(["codex"]);
    expect(s.calls.chat).toEqual([
      {
        token: "lk_codex",
        op: "say",
        text: "大家好，我是 codex（lianki · codex），实时监听（全部消息）入群。点名我必答，没点名但和我的项目有关的话也会简短答。",
        quiet: true,
      },
      {
        token: "lk_rechrome-main",
        op: "say",
        text: "大家好，我是 rechrome-main（rechrome · codex），只读入群。只回答点名我或「全体」的话。",
        quiet: true,
      },
      {
        token: "lk_lanes",
        op: "say",
        text: "还在等 token 才能入群：liagent-main, lianki-agent, lianki-coco-ui（偏好设置 → API tokens）",
        quiet: true,
      },
    ]);
    expect(s.calls.saved).toHaveLength(1);
    // Nothing new: nothing done, nothing saved.
    expect(await s.m.relist()).toEqual([]);
    expect(s.calls.saved).toHaveLength(1);
    // The listener exits by itself: it is started again on the next look.
    s.exits[0]!(3);
    await Bun.sleep(1);
    expect(s.m.running()).toEqual([]);
    expect((await s.m.relist()).map((a) => a.type)).toEqual(["start-listener"]);
  });
  it("小克 in the list: its listener starts with scope all, skipping his lines", async () => {
    const s = setup({
      tokens: ["agy", "codex", "claude", "lanes"],
      ay: [
        ...AGENTS,
        { pid: 77, cli: "claude", cwd: `${W}/snolab/lianki/tree/agy`, status: "active" },
      ],
    });
    await s.m.relist();
    expect(s.calls.started).toEqual(["codex:all:unnamed", "claude:all:skip"]);
  });
  it("an agent leaves: listener stopped, lane left; ay silent: nothing changes", async () => {
    const s = setup();
    await s.m.relist();
    s.setAy(AGENTS.filter((a) => a.pid !== 52435 && a.pid !== 71565));
    const acts = await s.m.relist();
    expect(acts).toEqual([
      { type: "stop-listener", lane: "codex" },
      { type: "left", lane: "codex" },
      { type: "left", lane: "rechrome-main" },
    ]);
    expect(s.calls.killed).toEqual(["codex"]);
    expect(s.calls.chat.slice(-2)).toEqual([
      { token: "lk_codex", op: "lane", state: "left" },
      { token: "lk_rechrome-main", op: "lane", state: "left" },
    ]);
    const quiet = setup({ ayRaw: "  " });
    expect(await quiet.m.relist()).toEqual([]);
    s.m.stop();
  });
  it("without the manager's token the missing list is only logged; a lane without a token is not greeted", async () => {
    const s = setup({ tokens: ["agy"] });
    await s.m.relist();
    expect(s.calls.chat).toEqual([]);
    expect(s.calls.logs.find((l) => l.type === "tokens-needed")).toMatchObject({ posted: false });
  });
  it("dry run: logs the actions, does none", async () => {
    const s = setup({ dryRun: true });
    const acts = await s.m.relist();
    expect(acts.length).toBeGreaterThan(0);
    expect(s.calls.started).toEqual([]);
    expect(s.calls.chat).toEqual([]);
    expect(s.calls.saved).toEqual([]);
    const l = JSON.stringify({
      type: "chat",
      message: { id: "a1", from: "owner", text: "rechrome-main，看看", thread: "owner" },
    });
    expect(await s.m.line(l)).toEqual([71565]);
    expect(s.calls.wake).toEqual([]);
  });
  it("line: wakes a reader named in his line, once per line; the first hand-off names the rules", async () => {
    const s = setup({ cfg: { ...CFG, wakeLiveMin: 0 } });
    await s.m.relist();
    const l = (id: string, text: string, extra = {}) =>
      JSON.stringify({
        type: "chat",
        message: { id, from: "owner", text, thread: "owner", at: 0 },
        ...extra,
      });
    expect(await s.m.line(l("a1", "rechrome-main，看看 #946"))).toEqual([71565]);
    expect(await s.m.line(l("a1", "rechrome-main，看看 #946"))).toEqual([]);
    expect(await s.m.line(l("a2", "#rechrome 再看一下"))).toEqual([71565]);
    expect(s.calls.wake[0]![1]).toContain("规则只读这一次");
    expect(s.calls.wake[1]![1]).not.toContain("规则只读这一次");
    expect(s.calls.wake[0]![1]).toContain("@你");
    // History, junk, a reader without a token: nothing.
    expect(await s.m.line(l("a3", "#rechrome x", { history: true }))).toEqual([]);
    expect(await s.m.line("not json")).toEqual([]);
    expect(await s.m.line(l("a4", "lianki-agent，在吗"))).toEqual([]);
    expect(s.m.planned().length).toBe(6);
    expect(s.m.state().greeted).toContain("codex");
  });
  it("named → live for lanes.wakeLiveMin after the last name, then a reader again", async () => {
    const s = setup();
    await s.m.relist();
    const l = (id: string, text: string) =>
      JSON.stringify({
        type: "chat",
        message: { id, from: "owner", text, thread: "owner", at: 0 },
      });
    const started = s.calls.started.length;
    // Named: woken now, and a listener of its own (his lines only) for 5 minutes.
    expect(await s.m.line(l("b1", "rechrome-main，看看"))).toEqual([71565]);
    // The named lane hears everything for the window (owner, 2026-11-15 23:11 JST).
    expect(s.calls.started.slice(started)).toEqual(["rechrome-main:all"]);
    expect(s.m.running()).toContain("rechrome-main");
    expect(s.m.wakeLive().get("rechrome-main")).toBe(1_000_000 + 5 * 60_000);
    // A re-list inside the window keeps that listener (live, so not stopped).
    expect(await s.m.relist()).toEqual([]);
    // Named again 4 min later: its listener hands it over; the window restarts.
    await s.advance(4 * 60_000);
    expect(await s.m.line(l("b2", "@rechrome-main 还有这个"))).toEqual([]);
    expect(s.calls.wake).toHaveLength(1);
    // 5 min after the first name: still live (the second one moved the end).
    await s.advance(60_000 + 1);
    expect(s.calls.killed).not.toContain("rechrome-main");
    // 5 min after the last name: a reader again.
    await s.advance(4 * 60_000);
    expect(s.calls.killed).toContain("rechrome-main");
    expect(s.m.running()).not.toContain("rechrome-main");
    expect(s.m.wakeLive().has("rechrome-main")).toBe(false);
    // Named once more: woken by the manager again, a new window.
    expect(await s.m.line(l("b3", "#rechrome 再看"))).toEqual([71565]);
    expect(s.calls.started.at(-1)).toBe("rechrome-main:all");
    s.m.stop();
  });
  it("scope all: the listener hears everyone (and skips his lines when the agent has its own feed)", () => {
    const k = plan("claude", { resident: true, scope: "all", wake: false, cwd: "/k", pid: 7 });
    const r = decide(
      [],
      {
        planned: [k],
        tokens: new Set(["claude"]),
        running: new Set<string>(),
        external: new Set<string>(),
      },
      { greeted: [] },
      { greeting: CFG.greeting },
    );
    expect(r.actions).toEqual([
      {
        type: "start-listener",
        lane: "claude",
        cwd: "/k",
        pid: 7,
        cli: "codex",
        scope: "all",
        skipOwner: true,
        answerUnnamed: false,
      },
      {
        type: "greet",
        lane: "claude",
        text: "大家好，我是 claude（lianki · codex），实时监听（全部消息）入群。只回答点名我或「全体」的话。",
      },
    ]);
  });
  it("a lane that answers unnamed lines: --answer-unnamed, and its own greeting", () => {
    const c = plan("codex", {
      resident: true,
      scope: "all",
      answerUnnamed: true,
      cwd: "/c",
      pid: 9,
    });
    const r = decide(
      [],
      {
        planned: [c],
        tokens: new Set(["codex"]),
        running: new Set<string>(),
        external: new Set<string>(),
      },
      { greeted: [] },
      CFG,
    );
    expect(r.actions).toEqual([
      {
        type: "start-listener",
        lane: "codex",
        cwd: "/c",
        pid: 9,
        cli: "codex",
        scope: "all",
        skipOwner: false,
        answerUnnamed: true,
      },
      {
        type: "greet",
        lane: "codex",
        text: "大家好，我是 codex（lianki · codex），实时监听（全部消息）入群。点名我必答，没点名但和我的项目有关的话也会简短答。",
      },
    ]);
    // Without the second template (an older cfg), the plain greeting.
    const old = decide(
      [],
      { planned: [c], tokens: new Set(["codex"]), running: new Set(), external: new Set() },
      { greeted: [] },
      { greeting: "hi {name}" },
    );
    expect(old.actions.at(-1)).toEqual({ type: "greet", lane: "codex", text: "hi codex" });
    expect(
      listenerArgv("bun", "/r", "codex", "/c", { scope: "all", answerUnnamed: true }).slice(-3),
    ).toEqual(["--all", "--everyone", "--answer-unnamed"]);
    expect(listenerArgv("bun", "/r", "agy", "/a", { cli: "agy", answerUnnamed: true })).toEqual([
      "bun",
      "/r/scripts/dev/lianki-dev.ts",
      "lane-listen",
      "--repo",
      "/r",
      "--as",
      "agy",
      "--cwd",
      "/a",
      "--cli",
      "agy",
      "--all",
      "--answer-unnamed",
    ]);
  });
  it("the listener's command line", () => {
    expect(
      listenerArgv("bun", "/r", "claude", "/c", { scope: "all", skipOwner: true }).slice(-3),
    ).toEqual(["--all", "--everyone", "--skip-owner"]);
    // The lane's CLI kind rides along, so the listener picks its agent among several in the dir.
    expect(
      listenerArgv("bun", "/r", "agy", "/a", { scope: "owner", cli: "agy" }).slice(-4),
    ).toEqual(["/a", "--cli", "agy", "--all"]);
    expect(listenerArgv("bun", "/r", "x", "/c", { scope: "all" }).slice(-2)).toEqual([
      "--all",
      "--everyone",
    ]);
    // --skip-owner only with --everyone: an owner-scope listener without his lines would hear nothing.
    expect(listenerArgv("bun", "/r", "x", "/c", { scope: "owner", skipOwner: true }).at(-1)).toBe(
      "--all",
    );
    expect(listenerArgv("bun", "/r", "codex", "/c")).toEqual([
      "bun",
      "/r/scripts/dev/lianki-dev.ts",
      "lane-listen",
      "--repo",
      "/r",
      "--as",
      "codex",
      "--cwd",
      "/c",
      "--all",
    ]);
  });
});
