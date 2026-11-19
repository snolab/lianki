// Who is busy (scripts/dev/lanes-busy.ts, and its wiring in lanes-manager-core.ts): an agent's
// live output = busy, quiet for lanes.busyIdleSec = idle, one hub call per change; ay's own
// states only for a lane whose follower cannot run. Every effect mocked.
import { describe, expect, it } from "bun:test";
import { lanesConfig } from "@/lib/lanes-config";
import { type BusyDeps, busyOfAy, createBusyTracker, parseAyEvent } from "@/scripts/dev/lanes-busy";
import { type Deps, createManager } from "@/scripts/dev/lanes-manager-core";
import { parseAyList } from "@/scripts/dev/lanes-manager-lib";

/** A fake world: followers we can write to or kill, timers we run by hand. */
function world(o: { failFollow?: Set<string> } = {}) {
  const sent: [string, boolean, boolean][] = [];
  const logs: Record<string, unknown>[] = [];
  const followers = new Map<
    string,
    { data: () => void; end: (why: string) => void; closed: boolean }
  >();
  let nextId = 0;
  const timers = new Map<number, { ms: number; fn: () => void }>();
  const d: BusyDeps = {
    follow: (path, data, end) => {
      if (o.failFollow?.has(path)) throw new Error("no tail");
      const f = { data, end, closed: false };
      followers.set(path, f);
      return { close: () => void (f.closed = true) };
    },
    send: (lane, busy, stuck) => void sent.push([lane, busy, stuck]),
    setTimer: (ms, fn) => {
      const id = ++nextId;
      timers.set(id, { ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
    log: (v) => void logs.push(v),
  };
  /** Run every pending timer of this length (the quiet window running out). */
  const elapse = (ms: number) => {
    for (const [id, t] of [...timers])
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
      }
  };
  return { d, sent, logs, followers, timers, elapse };
}

const LANES = [
  { lane: "codex", pid: 1, logFile: "/x/1.raw.log" },
  { lane: "agy", pid: 2, logFile: "/x/2.raw.log" },
];

describe("the busy tracker", () => {
  it("a write → busy once; more writes → nothing more; quiet → idle once", () => {
    const w = world();
    const b = createBusyTracker(w.d, { idleMs: 8_000 });
    b.sync(LANES);
    expect([...w.followers.keys()]).toEqual(["/x/1.raw.log", "/x/2.raw.log"]);
    w.followers.get("/x/1.raw.log")!.data();
    expect(w.sent).toEqual([["codex", true, false]]);
    for (let i = 0; i < 50; i++) w.followers.get("/x/1.raw.log")!.data();
    expect(w.sent).toEqual([["codex", true, false]]);
    // One quiet timer per lane, re-armed on writes (never more than one pending).
    expect(w.timers.size).toBe(2);
    w.elapse(8_000);
    // codex goes idle; agy never wrote: its first word is idle too (a ring from before is cleared).
    expect(w.sent).toEqual([
      ["codex", true, false],
      ["agy", false, false],
      ["codex", false, false],
    ]);
    w.elapse(8_000);
    expect(w.sent).toHaveLength(3);
    // Busy again on the next write.
    w.followers.get("/x/2.raw.log")!.data();
    expect(w.sent.at(-1)).toEqual(["agy", true, false]);
    expect(b.snapshot()).toMatchObject({
      agy: { fallback: false, following: true, sent: { busy: true } },
    });
  });
  it("sync: a gone lane that was busy is told idle and unfollowed; a restarted agent re-followed", () => {
    const w = world();
    const b = createBusyTracker(w.d, { idleMs: 5 });
    b.sync(LANES);
    w.followers.get("/x/1.raw.log")!.data();
    w.followers.get("/x/2.raw.log")!.data();
    // The same plan again: nothing.
    b.sync(LANES);
    expect(w.sent).toHaveLength(2);
    b.sync([{ lane: "agy", pid: 3, logFile: "/x/3.raw.log" }]);
    expect(w.sent).toEqual([
      ["codex", true, false],
      ["agy", true, false],
      ["codex", false, false],
    ]);
    expect(w.followers.get("/x/1.raw.log")!.closed).toBe(true);
    expect(w.followers.get("/x/2.raw.log")!.closed).toBe(true);
    // A write on the old log after it was replaced says nothing.
    w.followers.get("/x/2.raw.log")!.data();
    expect(w.sent).toHaveLength(3);
    // stop(): every busy lane told idle.
    w.followers.get("/x/3.raw.log")!.data();
    b.stop();
    expect(w.sent.slice(-1)).toEqual([["agy", false, false]]);
    expect(b.snapshot()).toEqual({});
  });
  it("no follower (none can start, no log, or it died): ay's states carry the lane; one call per change", () => {
    const w = world({ failFollow: new Set(["/x/1.raw.log"]) });
    const b = createBusyTracker(w.d, { idleMs: 8_000 });
    b.sync([...LANES, { lane: "nolog", pid: 9 }]);
    expect(w.logs.filter((l) => l.type === "busy-fallback").map((l) => l.lane)).toEqual(["codex"]);
    const line = (pid: number, state: string) =>
      JSON.stringify({ ts: 1, pid, cli: "codex", state });
    b.ayLine(line(1, "active"));
    b.ayLine(line(1, "active"));
    expect(w.sent).toEqual([["codex", true, false]]);
    b.ayLine(line(1, "stuck"));
    b.ayLine(line(1, "needs_input"));
    b.ayLine(line(9, "active"));
    // A lane with a follower ignores ay's states.
    b.ayLine(line(2, "active"));
    b.ayLine("not json");
    b.ayLine(JSON.stringify({ pid: 1, state: "dancing" }));
    expect(w.sent).toEqual([
      ["codex", true, false],
      ["codex", true, true],
      ["codex", false, false],
      ["nolog", true, false],
    ]);
    // A re-list's ay state counts for a fallback lane too.
    b.sync([
      ...LANES.map((p) => ({ ...p, state: "active" })),
      { lane: "nolog", pid: 9, state: "idle" },
    ]);
    expect(w.sent.slice(-2)).toEqual([
      ["codex", true, false],
      ["nolog", false, false],
    ]);
    // A follower that dies: the fallback until its retry (backing off), then the log again.
    const f2 = w.followers.get("/x/2.raw.log")!;
    f2.end("tail exited 1");
    expect(w.logs.at(-1)).toMatchObject({ type: "busy-fallback", lane: "agy", retryMs: 1_000 });
    b.ayLine(line(2, "active"));
    expect(w.sent.at(-1)).toEqual(["agy", true, false]);
    f2.end("again"); // a stale end after the switch: ignored
    w.elapse(1_000);
    const f3 = w.followers.get("/x/2.raw.log")!;
    expect(f3).not.toBe(f2);
    b.ayLine(line(2, "idle"));
    expect(w.sent.at(-1)).toEqual(["agy", true, false]);
    f3.end("x");
    expect(w.logs.at(-1)).toMatchObject({ retryMs: 2_000 });
  });
  it("parses ay's events; busy of each state", () => {
    expect(parseAyEvent('{"pid":1,"state":"idle","prev_state":"active"}')).toEqual({
      pid: 1,
      state: "idle",
    });
    expect(parseAyEvent("null")).toBeNull();
    expect(parseAyEvent('{"pid":"1","state":"idle"}')).toBeNull();
    expect(
      ["active", "idle", "needs_input", "stuck", "stopped"].map((s) => busyOfAy(s as never)),
    ).toEqual([
      { busy: true, stuck: false },
      { busy: false, stuck: false },
      { busy: false, stuck: false },
      { busy: true, stuck: true },
      { busy: false, stuck: false },
    ]);
  });
  it("a send that fails is not retried as a new change", async () => {
    const w = world();
    const b = createBusyTracker(
      { ...w.d, send: async () => Promise.reject(new Error("net")) },
      { idleMs: 8 },
    );
    b.sync(LANES.slice(0, 1));
    w.followers.get("/x/1.raw.log")!.data();
    await Promise.resolve();
    expect(b.snapshot().codex).toMatchObject({ sent: { busy: true } });
  });
});

describe("the manager tells the hub, with the lane's own token", () => {
  const W = "/Users/x/ws";
  const AY = [
    {
      pid: 52435,
      cli: "codex",
      cwd: `${W}/snolab/lianki/tree/codex`,
      status: "active",
      state: "idle",
      log_file: "/l/52435.raw.log",
    },
    {
      pid: 5468,
      cli: "agy",
      cwd: `${W}/snolab/lianki/tree/agy`,
      status: "active",
      log_file: "relative.log",
    },
    {
      pid: 7,
      cli: "codex",
      cwd: `${W}/snolab/lianki/tree/x`,
      status: "active",
      log_file: "/l/7.raw.log",
    },
  ];
  it("parseAyList keeps an absolute log_file only", () => {
    const rows = parseAyList(JSON.stringify(AY));
    expect(rows.map((r) => r.logFile)).toEqual(["/l/52435.raw.log", undefined, "/l/7.raw.log"]);
  });
  function setup(o: { dryRun?: boolean; refuse?: boolean } = {}) {
    const chat: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const data = new Map<string, () => void>();
    const timers: (() => void)[] = [];
    const tokens = new Set(["codex", "agy"]);
    const d: Deps = {
      ayList: async () => JSON.stringify(AY),
      ps: async () => "",
      token: (l) => (tokens.has(l) ? `lk_${l}` : undefined),
      startListener: () => ({ pid: 1, kill() {}, exited: new Promise(() => {}) }),
      chat: async (token, body) => {
        chat.push({ token, ...body });
        return o.refuse ? { ok: false, status: 403 } : { ok: true, status: 200 };
      },
      wake: async () => 0,
      loadState: () => ({ greeted: ["codex", "agy", "lianki-x"], missing: "lianki-x" }),
      saveState() {},
      log: (v) => void logs.push(v),
      follow: (path, onData) => {
        data.set(path, onData);
        return { close() {} };
      },
      setTimer: (_ms, fn) => timers.push(fn),
      clearTimer() {},
    };
    const m = createManager(d, {
      repo: "/r",
      cfg: lanesConfig({}),
      managerLane: "lanes",
      dryRun: o.dryRun,
    });
    return { m, chat, logs, data, timers };
  }
  it("follows only lanes with a token; one call per change; ay's line reaches the fallback lane", async () => {
    const s = setup();
    await s.m.relist();
    // codex has a log; agy's is not absolute (fallback); lianki-x has no token (not followed).
    expect([...s.data.keys()]).toEqual(["/l/52435.raw.log"]);
    const busyCalls = () => s.chat.filter((c) => c.op === "lane");
    s.data.get("/l/52435.raw.log")!();
    s.data.get("/l/52435.raw.log")!();
    await Promise.resolve();
    expect(busyCalls()).toEqual([{ token: "lk_codex", op: "lane", busy: true }]);
    s.m.ayLine(JSON.stringify({ pid: 5468, state: "stuck" }));
    s.m.ayLine(JSON.stringify({ pid: 5468, state: "stuck" }));
    await Promise.resolve();
    expect(busyCalls().at(-1)).toEqual({ token: "lk_agy", op: "lane", busy: true, stuck: true });
    expect(busyCalls()).toHaveLength(2);
    expect(s.m.busy()).toMatchObject({ codex: { following: true }, agy: { fallback: true } });
    s.m.stop();
    await Promise.resolve();
    expect(
      busyCalls()
        .slice(-2)
        .map((c) => [c.token, c.busy]),
    ).toEqual([
      ["lk_codex", false],
      ["lk_agy", false],
    ]);
  });
  it("a refusal is logged; a dry run sends nothing; no follow dep = no tracker", async () => {
    const s = setup({ refuse: true });
    await s.m.relist();
    s.data.get("/l/52435.raw.log")!();
    await new Promise((r) => setTimeout(r, 1));
    expect(s.logs.some((l) => l.type === "busy-refused" && l.status === 403)).toBe(true);
    const dry = setup({ dryRun: true });
    await dry.m.relist();
    dry.data.get("/l/52435.raw.log")!();
    await Promise.resolve();
    expect(dry.chat.filter((c) => c.op === "lane")).toEqual([]);
    const bare = createManager(
      {
        ayList: async () => "",
        ps: async () => "",
        token: () => undefined,
        startListener: () => ({ pid: 1, kill() {}, exited: new Promise(() => {}) }),
        chat: async () => ({ ok: true, status: 200 }),
        wake: async () => 0,
        loadState: () => ({ greeted: [] }),
        saveState() {},
        log() {},
      },
      { repo: "/r", cfg: lanesConfig({}), managerLane: "lanes" },
    );
    bare.ayLine("{}");
    expect(bare.busy()).toBeNull();
    bare.stop();
  });
  it("default timers: setTimeout and clearTimeout", async () => {
    const s = setup();
    const m = createManager(
      {
        ayList: async () => JSON.stringify(AY.slice(0, 1)),
        ps: async () => "",
        token: (l) => (l === "codex" ? "lk" : undefined),
        startListener: () => ({ pid: 1, kill() {}, exited: new Promise(() => {}) }),
        chat: async () => ({ ok: true, status: 200 }),
        wake: async () => 0,
        loadState: () => ({ greeted: ["codex"] }),
        saveState() {},
        log() {},
        follow: (path, onData) => {
          s.data.set(path, onData);
          return { close() {} };
        },
      },
      { repo: "/r", cfg: lanesConfig({ LIANKI_LANES_BUSY_IDLE_SEC: "1" }), managerLane: "lanes" },
    );
    await m.relist();
    s.data.get("/l/52435.raw.log")!();
    s.data.get("/l/52435.raw.log")!();
    expect(m.busy()).toMatchObject({ codex: { sent: { busy: true } } });
    m.stop();
  });
});
