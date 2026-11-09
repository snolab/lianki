// The machine-wide gate for heavy local runs (docs/shipping.md, "One heavy run at
// a time"). The lock's rules run in process, the wrapper through real child
// processes: nothing here waits on a timer except for an observable effect.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Holder,
  LOAD_RATIO_ENV,
  LOCK_ENV,
  LONG_HOLD_MS,
  MAX_RUNS_ENV,
  MIN_FREE_GB_ENV,
  PROGRESS_EVERY_MS,
  SETTLE_S_ENV,
  TOKEN_ENV,
  acquireGate,
  admission,
  describeHolder,
  gateRules,
  isCi,
  isHolderAlive,
  isNarrowedSuite,
  isReentrant,
  isReentrantAny,
  jst,
  liveHolders,
  lockPath,
  makeHolder,
  measureRoom,
  parseLockArgs,
  parseVmStat,
  processStartTime,
  readLock,
  release,
  shouldBackOff,
  slotPaths,
  tryAcquire,
  tryAcquireSlot,
  waitReporter,
} from "../scripts/dev/machine-lock-lib";

const CLI = join(import.meta.dir, "../scripts/dev/machine-lock.ts");
const hasPs = processStartTime() !== null;

let dir: string;
let lock: string;
const running: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "machine-lock-"));
  lock = join(dir, "gate.lock");
});

afterEach(() => {
  for (const c of running.splice(0)) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const until = async (what: string, ok: () => boolean) => {
  const deadline = Date.now() + 20_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/**
 * The test may itself run under the lock, or in CI: children start clean. One
 * run at a time unless a test asks for more (`roomy`), so the one-run rules are
 * tested as such.
 */
/** Admission that only the cap limits: no load, memory or settle wait. */
const roomy = (runs: number) => ({
  [MAX_RUNS_ENV]: String(runs),
  [LOAD_RATIO_ENV]: "1000",
  [MIN_FREE_GB_ENV]: "0",
  [SETTLE_S_ENV]: "0",
});

const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env[TOKEN_ENV];
  return { ...env, [LOCK_ENV]: lock, [MAX_RUNS_ENV]: "1", LIANKI_GATE_POLL_MS: "20", ...extra };
};

/** Starts the wrapper around a shell line; stderr and stdout go to `<name>.log`. */
function wrapper(
  name: string,
  line: string,
  env: Record<string, string> = {},
  flags: string[] = [],
) {
  const log = join(dir, `${name}.log`);
  const fd = openSync(log, "a");
  const c = spawn(process.execPath, [CLI, ...flags, "--", "sh", "-c", line], {
    cwd: dir,
    env: cleanEnv(env),
    stdio: ["ignore", fd, fd],
  });
  running.push(c);
  const done = new Promise<number | null>((res) => c.on("exit", (code) => res(code)));
  return { child: c, done, log: () => readFileSync(log, "utf8") };
}

/**
 * Until the waiter has printed its whole first report: the `waiting:` line and a
 * `held by` line naming each of `holders`. They are separate writes, so a test
 * that stops at the first one can read the log between them (that flaked in CI).
 */
const waitingOn = (w: ReturnType<typeof wrapper>, ...holders: string[]) =>
  until(`the waiter to name ${holders.join(", ") || "its reason"}`, () => {
    const log = w.log();
    const named = log.split("\n").filter((l) => l.includes("held by"));
    return log.includes("waiting:") && holders.every((h) => named.some((l) => l.includes(h)));
  });

/** A shell line that runs until the test creates `<name>.go`; `$$` lands in `<name>.up`. */
const blocker = (name: string, then = "") =>
  `echo $$ > ${name}.up.tmp; mv ${name}.up.tmp ${name}.up; until [ -f ${name}.go ]; do sleep 0.02; done; ${then}`;
const up = (name: string) => existsSync(join(dir, `${name}.up`));
const go = (name: string) => writeFileSync(join(dir, `${name}.go`), "");

/** The pid of a process that has really exited. */
function deadPid(): number {
  return spawnSync("true").pid;
}

const fakeHolder = (over: Partial<Holder> = {}): Holder => ({
  token: "tok",
  pid: deadPid(),
  startTime: "Sat Nov 7 01:00:00 2026",
  worktree: "/w/elsewhere",
  command: "bun test",
  startedAt: "2026-11-07T01:00:00.000Z",
  ...over,
});
const plant = (h: Holder, path = lock) => writeFileSync(path, JSON.stringify(h));

describe("arguments and paths", () => {
  test("the lock path is fixed, not the session's own TMPDIR", () => {
    expect(lockPath({ TMPDIR: "/var/x" }, "darwin")).toBe("/tmp/lianki-gate.lock");
    expect(lockPath({}, "linux")).toBe("/tmp/lianki-gate.lock");
    expect(lockPath({}, "win32")).toEndWith("lianki-gate.lock");
    expect(lockPath({ [LOCK_ENV]: "/x/y" }, "linux")).toBe("/x/y");
  });

  test("CI is any non-empty value but false and 0", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(true);
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
  });

  test("parseLockArgs", () => {
    expect(parseLockArgs(["--", "bun", "test"])).toEqual({
      wholeSuite: false,
      command: ["bun", "test"],
    });
    expect(parseLockArgs(["--whole-suite", "--label", "x", "--", "a", "--", "b"])).toEqual({
      wholeSuite: true,
      label: "x",
      command: ["a", "--", "b"],
    });
    // Bun drops a `--` straight after the script's name, and only that one.
    expect(parseLockArgs(["bun", "test", "--", "--coverage"])).toEqual({
      wholeSuite: false,
      command: ["bun", "test", "--", "--coverage"],
    });
    expect(parseLockArgs(["--"])).toEqual({ error: "no command given" });
    expect(parseLockArgs([])).toEqual({ error: "no command given" });
    expect(parseLockArgs(["--nope", "--", "a"])).toEqual({ error: "bad option --nope" });
    expect(parseLockArgs(["--label", "--", "a"])).toEqual({ error: "bad option --label" });
    expect(parseLockArgs(["--label"])).toEqual({ error: "bad option --label" });
  });

  test("a file or a name narrows `bun test`; flags alone do not", () => {
    expect(isNarrowedSuite(["bun", "test"])).toBe(false);
    expect(isNarrowedSuite(["bun", "test", "--coverage"])).toBe(false);
    expect(isNarrowedSuite(["bun", "test", "unit/dates.test.ts"])).toBe(true);
    expect(isNarrowedSuite(["bun", "test", "--coverage", "dates"])).toBe(true);
  });
});

describe("liveness", () => {
  test("this process is alive; the pid of an exited one is not", () => {
    expect(isHolderAlive({ pid: process.pid, startTime: processStartTime() })).toBe(true);
    expect(isHolderAlive({ pid: deadPid(), startTime: null })).toBe(false);
  });

  test.skipIf(!hasPs)("a live pid with another start time was reused: dead", () => {
    expect(isHolderAlive({ pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970" })).toBe(false);
  });

  test("a live pid with no recorded start time counts as alive", () => {
    expect(isHolderAlive({ pid: process.pid, startTime: null })).toBe(true);
  });

  test("a pid that exists but is someone else's (EPERM) counts as alive", () => {
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no"), { code: "EPERM" });
    });
    try {
      expect(isHolderAlive({ pid: process.pid, startTime: null })).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  test.skipIf(!hasPs || process.platform === "win32")(
    "a zombie is dead",
    async () => {
      // A shell starts a child, then replaces itself with a sleep, which never
      // reaps. The child exits only once the sleep is in place: had it exited
      // while the shell still ran, the shell would have reaped it, no zombie ever
      // (what timed this test out under load).
      const ps = (pid: number, field: string) =>
        spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      const c = spawn(
        "sh",
        [
          "-c",
          // Also ends with its parent, so a failed test leaves nothing behind.
          `sh -c 'until [ -f z.go ] || ! kill -0 $PPID 2>/dev/null; do sleep 0.01; done' & echo $! > z.tmp; mv z.tmp z; exec sleep 30`,
        ],
        { cwd: dir, stdio: "ignore" },
      );
      running.push(c);
      await until("the child's pid", () => existsSync(join(dir, "z")));
      const pid = Number(readFileSync(join(dir, "z"), "utf8"));
      await until("the shell to become the sleep", () =>
        /(^|\/)sleep$/.test(ps(c.pid as number, "comm")),
      );
      expect(isHolderAlive({ pid, startTime: null })).toBe(true);
      writeFileSync(join(dir, "z.go"), "");
      await until("the zombie", () => ps(pid, "stat").startsWith("Z"));
      expect(isHolderAlive({ pid, startTime: null })).toBe(false);
    },
    30_000,
  );
});

describe("the lock file", () => {
  test("acquire, refuse while alive, release", () => {
    const me = makeHolder("first");
    expect(me.pid).toBe(process.pid);
    expect(tryAcquire(lock, me)).toEqual({ acquired: true, tookOver: [] });
    expect(readLock(lock)?.holder).toEqual(me);

    const other = makeHolder("second");
    const r = tryAcquire(lock, other);
    expect(r).toMatchObject({ acquired: false, holder: { token: me.token } });

    release(lock, "not the token");
    expect(existsSync(lock)).toBe(true);
    release(lock, me.token);
    expect(existsSync(lock)).toBe(false);
    release(lock, me.token); // already gone: fine
    expect(readLock(lock)).toBeNull();
  });

  test.skipIf(process.platform === "win32")("the lock file is private to this user", () => {
    tryAcquire(lock, makeHolder("me"));
    expect(statSync(lock).mode & 0o777).toBe(0o600);
  });

  test("leaves no temp files behind", () => {
    const me = makeHolder("x");
    tryAcquire(lock, me);
    tryAcquire(lock, makeHolder("y"));
    expect(readdirSync(dir)).toEqual(["gate.lock"]);
  });

  test("a dead holder is taken over, and reported", () => {
    const dead = fakeHolder();
    plant(dead);
    const me = makeHolder("me");
    const r = tryAcquire(lock, me);
    expect(r.acquired).toBe(true);
    expect(r.tookOver.map((s) => s.holder?.token)).toEqual([dead.token]);
    expect(readLock(lock)?.holder?.token).toBe(me.token);
    expect(readdirSync(dir)).toEqual(["gate.lock"]);
  });

  test.skipIf(!hasPs)("a holder whose pid was reused is taken over", () => {
    plant(fakeHolder({ pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970" }));
    expect(tryAcquire(lock, makeHolder("me")).acquired).toBe(true);
  });

  test("a live holder is never taken over, however old", () => {
    const old = {
      ...makeHolder("very long"),
      startedAt: new Date(Date.now() - 10 * LONG_HOLD_MS).toISOString(),
    };
    plant(old);
    expect(tryAcquire(lock, makeHolder("me"))).toMatchObject({
      acquired: false,
      holder: { token: old.token },
    });
  });

  test("garbage in the lock file is cleared", () => {
    for (const junk of ["not json", "{}", '{"token":"t","pid":-1}']) {
      writeFileSync(lock, junk);
      const me = makeHolder("me");
      const r = tryAcquire(lock, me);
      expect(r.acquired).toBe(true);
      expect(r.tookOver[0].holder).toBeNull();
      release(lock, me.token);
    }
  });

  test("a live takeover marker makes others wait; a stranded one is cleared", () => {
    plant(fakeHolder());
    const marker = (() => {
      // Learn the marker's name from a real takeover of the same content.
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(readFileSync(lock, "utf8"));
      return `${lock}.takeover-${hasher.digest("hex").slice(0, 12)}`;
    })();

    plant(makeHolder("another waiter, mid-takeover"), marker);
    expect(tryAcquire(lock, makeHolder("me"))).toEqual({
      acquired: false,
      holder: null,
      tookOver: [],
    });
    expect(existsSync(lock)).toBe(true);

    plant(fakeHolder({ token: "dead-taker" }), marker);
    const r = tryAcquire(lock, makeHolder("me"));
    expect(r.acquired).toBe(true);
    expect(readdirSync(dir)).toEqual(["gate.lock"]);
  });

  test("an error other than EEXIST and ENOENT surfaces", () => {
    expect(() => tryAcquire(join(dir, "no", "such", "dir", "x"), makeHolder("me"))).toThrow();
    expect(() => readLock(dir)).toThrow();
  });

  test("re-entrant only with the live holder's own token", () => {
    expect(isReentrant(lock, undefined)).toBe(false);
    expect(isReentrant(lock, "tok")).toBe(false);
    const me = makeHolder("me");
    tryAcquire(lock, me);
    expect(isReentrant(lock, me.token)).toBe(true);
    expect(isReentrant(lock, "other")).toBe(false);
    rmSync(lock);
    plant(fakeHolder({ token: "orphaned" }));
    expect(isReentrant(lock, "orphaned")).toBe(false);
  });
});

describe("admission by load", () => {
  const GB = 1024 ** 3;
  const rules = gateRules({}, 18);
  const T = Date.parse("2026-11-08T11:00:00Z");
  const runningFor = (s: number, token = `r${s}`) =>
    fakeHolder({ token, acquiredAt: new Date(T - s * 1000).toISOString() });
  const room = (load: number, freeGb: number | null = 8) => ({
    load,
    cores: 18,
    availBytes: freeGb === null ? null : freeGb * GB,
  });

  test("defaults: load under 0.9 x cores, 2 GB free, 15 s settle, cap = cores; env overrides", () => {
    expect(rules).toEqual({ maxRuns: 18, loadRatio: 0.9, minFreeBytes: 2 * GB, settleMs: 15_000 });
    expect(
      gateRules(
        {
          [MAX_RUNS_ENV]: "3",
          [LOAD_RATIO_ENV]: "0.5",
          [MIN_FREE_GB_ENV]: "6",
          [SETTLE_S_ENV]: "0",
        },
        18,
      ),
    ).toEqual({ maxRuns: 3, loadRatio: 0.5, minFreeBytes: 6 * GB, settleMs: 0 });
    for (const bad of ["", "x", "-1"]) {
      expect(gateRules({ [MAX_RUNS_ENV]: bad, [LOAD_RATIO_ENV]: bad }, 18)).toEqual(rules);
    }
    expect(gateRules({}, 0).maxRuns).toBe(1);
  });

  test("nothing else running: always admitted, however busy the machine", () => {
    expect(admission([], room(500, 0.1), rules, T).admit).toBe(true);
  });

  test("beside others: admitted only with room — load and memory, both", () => {
    const others = [runningFor(120)];
    expect(admission(others, room(10), rules, T)).toEqual({
      admit: true,
      why: "room: load 10.0/16.2, mem 8.0 GB free",
    });
    expect(admission(others, room(16.2), rules, T)).toEqual({
      admit: false,
      why: "load 16.2/16.2 is too high (mem 8.0 GB free)",
    });
    expect(admission(others, room(4, 1.5), rules, T)).toEqual({
      admit: false,
      why: "mem 1.5 GB free, under 2.0 GB (load 4.0/16.2)",
    });
    // Memory unknown (vm_stat missing): judged by load alone.
    expect(admission(others, room(4, null), rules, T).admit).toBe(true);
  });

  test("not while the newest run is younger than the settle time: loadavg lags", () => {
    expect(admission([runningFor(120), runningFor(5)], room(1), rules, T)).toEqual({
      admit: false,
      why: "the newest run started 5 s ago; its load shows in 10 s",
    });
    expect(admission([runningFor(15)], room(1), rules, T).admit).toBe(true);
    // A holder from before admission has only startedAt.
    const old = fakeHolder({ startedAt: new Date(T - 3000).toISOString() });
    expect(admission([old], room(1), rules, T).admit).toBe(false);
  });

  test("the cap is a safety net, not the normal limit", () => {
    const capped = { ...rules, maxRuns: 2 };
    expect(admission([runningFor(100, "a"), runningFor(90, "b")], room(0), capped, T)).toEqual({
      admit: false,
      why: "2 runs, the safety cap (LIANKI_GATE_MAX_RUNS)",
    });
  });

  test("two admitted in the same moment: the later one backs off, exactly one stays", () => {
    const a = runningFor(0, "a");
    const b = { ...runningFor(0, "b") };
    expect(shouldBackOff(a, [b], rules)).toBe(false);
    expect(shouldBackOff(b, [a], rules)).toBe(true);
    const later = runningFor(-2, "z");
    expect(shouldBackOff(later, [a], rules)).toBe(true);
    expect(shouldBackOff(a, [later], rules)).toBe(false);
    expect(shouldBackOff(a, [runningFor(60, "old")], rules)).toBe(false);
  });

  test("vm_stat: free + inactive + speculative pages times the page size", () => {
    const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            900000.
Pages inactive:                           20000.
Pages speculative:                         5000.
`;
    expect(parseVmStat(out)).toBe(35000 * 16384);
    expect(parseVmStat("garbage")).toBeNull();
    const room = measureRoom();
    expect(room.cores).toBeGreaterThan(0);
    expect(room.availBytes === null || room.availBytes > 0).toBe(true);
    expect(measureRoom("linux").availBytes).toBeGreaterThan(0);
  });

  test("the slot files: slot 1 is the old single lock's path", () => {
    expect(slotPaths("/tmp/lianki-gate.lock", 2)).toEqual([
      "/tmp/lianki-gate.lock",
      "/tmp/lianki-gate.lock.2",
    ]);
  });

  test("a waiter says why it waits, once per reason, and is admitted when room appears", async () => {
    const paths = slotPaths(lock, 4);
    const other = { ...makeHolder("other"), acquiredAt: new Date(T - 60_000).toISOString() };
    plant(other, paths[0]);
    let t = T;
    let load = 30;
    const lines: string[] = [];
    let measured = 0;
    const got = await acquireGate(paths, makeHolder("me"), {
      say: (l) => lines.push(l),
      pollMs: 1000,
      roomEveryMs: 15_000,
      rules,
      now: () => t,
      measure: () => (measured++, room(load)),
      sleep: async (ms) => {
        t += ms;
        if (t - T > 40_000) load = 3;
      },
    });
    expect(got.path).toBe(paths[1]);
    expect(lines.filter((l) => l.startsWith("waiting: load"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("held by pid"))).toBe(true);
    expect(lines.at(-1)).toContain("admitted at");
    // Measured at most every 15 s while waiting, not on each poll.
    expect(measured).toBeLessThanOrEqual(Math.ceil((t - T) / 15_000) + 1);
    expect(readLock(paths[1])?.holder?.acquiredAt).toBe(got.me.acquiredAt);
  });

  test("re-entrant in whichever slot the live holder has", () => {
    const paths = slotPaths(lock, 2);
    plant(makeHolder("other"), paths[0]);
    const me = makeHolder("me");
    expect(tryAcquireSlot(paths, me)).toMatchObject({ acquired: true, path: paths[1] });
    expect(isReentrantAny(paths, me.token)).toBe(true);
    expect(isReentrantAny(paths, "stale")).toBe(false);
    expect(isReentrantAny(paths, undefined)).toBe(false);
    expect(liveHolders(paths, me.token).map((h) => h.command)).toEqual(["other"]);
  });
});

describe("what a waiter prints", () => {
  test("times are JST and labelled", () => {
    expect(jst(Date.parse("2026-11-07T01:02:03Z"))).toBe("2026-11-07 10:02:03 JST");
    expect(describeHolder(fakeHolder({ pid: 7 }))).toBe(
      "pid 7, /w/elsewhere, `bun test`, started 2026-11-07 10:00:00 JST",
    );
  });

  test("each holder once, progress at most once a minute, one long-hold warning", () => {
    let t = Date.parse("2026-11-07T01:00:00Z");
    const report = waitReporter(() => t);
    const a = fakeHolder({ token: "a", startedAt: new Date(t).toISOString() });

    expect(report(a)[0]).toStartWith("held by pid");
    t += PROGRESS_EVERY_MS - 1;
    expect(report(a)).toEqual([]);
    t += 1;
    expect(report(a)).toEqual(["still waiting, 1 min so far"]);
    t += PROGRESS_EVERY_MS / 2;
    expect(report(a)).toEqual([]);

    const b = fakeHolder({ token: "b", startedAt: new Date(t).toISOString() });
    expect(report(b)).toHaveLength(1);
    expect(report(null)).toEqual([]);

    t = Date.parse(b.startedAt) + LONG_HOLD_MS;
    const lines = report(b);
    expect(lines.filter((l) => l.startsWith("warning:"))).toHaveLength(1);
    expect(lines[0]).toContain(`pid ${b.pid}`);
    expect(lines[0]).toContain("not taken over");
    t += PROGRESS_EVERY_MS / 2;
    expect(report(b).filter((l) => l.startsWith("warning:"))).toEqual([]);
  });
});

describe("the wrapper, as real processes", () => {
  const TIMEOUT = 30_000;
  const heldBy = () => readLock(lock)?.holder ?? null;

  test(
    "two contenders serialize; the waiter names the holder once",
    async () => {
      const a = wrapper("a", blocker("a", "echo a-end >> order"), {}, ["--label", "the first run"]);
      await until("a to start", () => up("a"));
      expect(heldBy()?.command).toBe("the first run");
      expect(heldBy()?.pid).toBe(a.child.pid as number);
      expect(heldBy()?.worktree).toEndWith(dir.split("/").pop() as string);

      const b = wrapper("b", "echo b-ran >> order");
      await waitingOn(b, `pid ${a.child.pid}`);
      expect(existsSync(join(dir, "order"))).toBe(false);
      expect(b.log()).toContain("the first run");

      go("a");
      expect(await a.done).toBe(0);
      expect(await b.done).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("a-end\nb-ran\n");
      // Once over the whole wait, however many polls it took.
      expect(b.log().match(/held by/g)).toHaveLength(1);
      expect(existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a holder killed outright is taken over; a live one was not",
    async () => {
      const a = wrapper("a", blocker("a"));
      await until("a to start", () => up("a"));
      const command = Number(readFileSync(join(dir, "a.up"), "utf8"));
      const pid = a.child.pid as number;

      const b = wrapper("b", "echo b-ran >> order");
      await waitingOn(b);
      expect(existsSync(join(dir, "order"))).toBe(false);

      a.child.kill("SIGKILL");
      expect(await b.done).toBe(0);
      expect(b.log()).toContain(`took over from a dead holder: pid ${pid}`);
      expect(existsSync(lock)).toBe(false);
      process.kill(command, "SIGKILL"); // it outlived its wrapper
    },
    TIMEOUT,
  );

  test(
    "pid reuse: a lock naming a live process of another start time does not block",
    async () => {
      if (!hasPs) return;
      plant(fakeHolder({ pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970" }));
      const b = wrapper("b", "echo ran >> order");
      expect(await b.done).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("ran\n");
    },
    TIMEOUT,
  );

  test(
    "many contenders racing over one dead holder: never two running at once",
    async () => {
      plant(fakeHolder());
      const line = `mkdir busy || echo overlap >> bad; echo x >> count; sleep 0.02; rmdir busy`;
      const all = Array.from({ length: 6 }, (_, i) => wrapper(`c${i}`, line));
      expect(await Promise.all(all.map((c) => c.done))).toEqual([0, 0, 0, 0, 0, 0]);
      expect(existsSync(join(dir, "bad"))).toBe(false);
      expect(readFileSync(join(dir, "count"), "utf8")).toBe("x\n".repeat(6));
      expect(existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "cap 2: two run at once, a third waits naming both, and runs when one ends",
    async () => {
      const two = roomy(2);
      const a = wrapper("a", blocker("a"), two, ["--label", "run a"]);
      await until("a to start", () => up("a"));
      const b = wrapper("b", blocker("b"), two, ["--label", "run b"]);
      await until("b to start beside a", () => up("b"));
      expect(readLock(`${lock}.2`)?.holder?.command).toBe("run b");

      const c = wrapper("c", "echo c-ran >> order", two);
      await waitingOn(c, "`run a`", "`run b`");
      expect(c.log()).toContain("waiting: 2 runs, the safety cap");
      expect(existsSync(join(dir, "order"))).toBe(false);

      go("b");
      expect(await b.done).toBe(0);
      expect(await c.done).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("c-ran\n");
      go("a");
      expect(await a.done).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(`${lock}.2`)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "cap 2: a holder killed outright (kill -9) is taken over by a waiter",
    async () => {
      const two = roomy(2);
      const a = wrapper("a", blocker("a"), two);
      await until("a to start", () => up("a"));
      const b = wrapper("b", blocker("b"), two);
      await until("b to start", () => up("b"));
      const bCommand = Number(readFileSync(join(dir, "b.up"), "utf8"));
      const c = wrapper("c", "echo c-ran >> order", two);
      await waitingOn(c);

      b.child.kill("SIGKILL");
      expect(await c.done).toBe(0);
      expect(c.log()).toContain(`took over from a dead holder: pid ${b.child.pid}`);
      process.kill(bCommand, "SIGKILL"); // it outlived its wrapper
      go("a");
      expect(await a.done).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "cap 2, many contenders racing: never more than two running at once",
    async () => {
      plant(fakeHolder());
      // Each run takes one of two seats with mkdir; a third seat taken = overlap.
      const line = `if mkdir s1 2>/dev/null; then s=s1; elif mkdir s2 2>/dev/null; then s=s2; else echo overlap >> bad; s=; fi; echo x >> count; sleep 0.05; [ -n "$s" ] && rmdir $s`;
      const all = Array.from({ length: 6 }, (_, i) => wrapper(`c${i}`, line, roomy(2)));
      expect(await Promise.all(all.map((c) => c.done))).toEqual([0, 0, 0, 0, 0, 0]);
      expect(existsSync(join(dir, "bad"))).toBe(false);
      expect(readFileSync(join(dir, "count"), "utf8")).toBe("x\n".repeat(6));
      expect(readdirSync(dir).filter((f) => f.startsWith("gate.lock"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "nested use is re-entrant: no deadlock, and the inner run does not release",
    async () => {
      const inner = `"${process.execPath}" "${CLI}" -- sh -c 'echo inner >> order'`;
      const after = `test -f gate.lock && echo still-held >> order`;
      const a = wrapper("a", `${inner}; ${after}`);
      expect(await a.done).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("inner\nstill-held\n");
      expect(a.log()).not.toContain("waiting");
      expect(existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a stale token in the environment does not skip the lock",
    async () => {
      const a = wrapper("a", blocker("a"));
      await until("a to start", () => up("a"));
      const b = wrapper("b", "echo ran >> order", { [TOKEN_ENV]: "from-a-finished-run" });
      await waitingOn(b);
      expect(existsSync(join(dir, "order"))).toBe(false);
      go("a");
      expect(await b.done).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "a failing command passes on its code and releases",
    async () => {
      const a = wrapper("a", "exit 7");
      expect(await a.done).toBe(7);
      expect(existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a command that cannot start is 127 and releases",
    async () => {
      const c = spawnSync(process.execPath, [CLI, "--", join(dir, "no-such-command")], {
        env: cleanEnv(),
        encoding: "utf8",
      });
      expect(c.status).toBe(127);
      expect(existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "usage errors are 2 and run nothing",
    () => {
      const c = spawnSync(process.execPath, [CLI, "--bad", "--", "true"], {
        env: cleanEnv(),
        encoding: "utf8",
      });
      expect(c.status).toBe(2);
      expect(c.stderr).toContain("usage:");
    },
    TIMEOUT,
  );

  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    test(
      `${sig} reaches the command, and the lock is released after it is gone`,
      async () => {
        const trap = `trap 'echo got-signal >> order; exit ${code}' ${sig.slice(3)}; ${blocker("a")}`;
        const a = wrapper("a", trap);
        await until("a to start", () => up("a"));
        a.child.kill(sig);
        expect(await a.done).toBe(code);
        expect(readFileSync(join(dir, "order"), "utf8")).toBe("got-signal\n");
        expect(existsSync(lock)).toBe(false);
      },
      TIMEOUT,
    );
  }

  test(
    "a command killed by a signal is reported as 128+n and releases",
    async () => {
      const a = wrapper("a", "kill -KILL $$");
      expect(await a.done).toBe(137);
      expect(existsSync(lock)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a signal while waiting ends the waiter and leaves the holder's lock",
    async () => {
      const a = wrapper("a", blocker("a"));
      await until("a to start", () => up("a"));
      const b = wrapper("b", "echo ran >> order");
      await waitingOn(b);
      b.child.kill("SIGTERM");
      expect(await b.done).toBe(143);
      expect(existsSync(join(dir, "order"))).toBe(false);
      expect(heldBy()?.pid).toBe(a.child.pid as number);
      go("a");
      expect(await a.done).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "CI: no lock at all, even while someone holds it",
    async () => {
      const h = makeHolder("held by this test");
      plant(h);
      const a = wrapper("a", `test -z "$${TOKEN_ENV}" && echo ran >> order`, { CI: "true" });
      expect(await a.done).toBe(0);
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("ran\n");
      expect(readLock(lock)?.holder?.token).toBe(h.token);
    },
    TIMEOUT,
  );

  test(
    "--whole-suite: a narrowed `bun test` skips the lock, the whole suite takes it",
    async () => {
      plant(makeHolder("held by this test"));
      const fakeBunDir = join(dir, "bin");
      mkdirSync(fakeBunDir);
      // A stand-in `bun`, so this does not recurse into the real suite.
      writeFileSync(join(fakeBunDir, "bun"), '#!/bin/sh\necho "ran $*" >> order\n', {
        mode: 0o755,
      });
      const log = join(dir, "whole.log");
      const fd = openSync(log, "a");
      const run = (...tail: string[]) => {
        const c = spawn(process.execPath, [CLI, "--whole-suite", "--", "bun", "test", ...tail], {
          cwd: dir,
          env: cleanEnv({ PATH: `${fakeBunDir}:${process.env.PATH}` }),
          stdio: ["ignore", fd, fd],
        });
        running.push(c);
        return new Promise((res) => c.on("exit", res));
      };
      const order = () => readFileSync(join(dir, "order"), "utf8");

      await run("unit/dates.test.ts");
      expect(order()).toBe("ran test unit/dates.test.ts\n");

      const whole = run("--coverage");
      await until("the whole suite to queue", () => readFileSync(log, "utf8").includes("waiting"));
      expect(order()).toBe("ran test unit/dates.test.ts\n");

      rmSync(lock);
      await whole;
      expect(order()).toContain("ran test --coverage\n");
    },
    TIMEOUT,
  );

  test(
    "an unusable lock path warns and still runs the command",
    async () => {
      const a = wrapper("a", "echo ran >> order", { [LOCK_ENV]: join(dir, "no", "dir", "x") });
      expect(await a.done).toBe(0);
      expect(a.log()).toContain("running without the lock");
      expect(readFileSync(join(dir, "order"), "utf8")).toBe("ran\n");
    },
    TIMEOUT,
  );
});

describe("what is wired to the lock", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  const hook = readFileSync(join(import.meta.dir, "../.husky/pre-push"), "utf8");

  test("the unit suite and qa:all start at once: only the time-sensitive suites wait", () => {
    expect(pkg.scripts["test:unit"]).toBe("bun test");
    expect(pkg.scripts["qa:all"]).toBe("bun scripts/qa/qa-all.mjs");
    const qaAll = readFileSync(join(import.meta.dir, "../scripts/qa/qa-all.mjs"), "utf8");
    expect(qaAll).toContain("await runSuites(CHOSEN, BASE, log)");
  });

  test("the suites' time-sensitive tags are data in one list, and every suite has one", async () => {
    const { SUITES } = await import("../scripts/qa/suites.mjs");
    expect(SUITES[0].name).toStartWith("AUDIO-FREE");
    for (const s of SUITES) expect(typeof s.sensitive).toBe("boolean");
    const sensitive = SUITES.filter((s: { sensitive: boolean }) => s.sensitive).map(
      (s: { name: string }) => s.name.split(" (")[0],
    );
    expect(sensitive).toEqual([
      "WORDS",
      "READ EPUB",
      "READ SEL ONE",
      "SYNC",
      "PARTNER FRAME",
      "PILL CHAT",
    ]);
  });

  test("pre-push runs lint, typecheck, unit, qa in order, with no gate of its own", () => {
    const at = (s: string) => hook.indexOf(`\n${s}`);
    expect(at("bun run lint")).toBeLessThan(at("bun run typecheck"));
    expect(at("bun run typecheck")).toBeLessThan(at("bun scripts/gate/affected.ts unit"));
    expect(at("bun scripts/gate/affected.ts unit")).toBeLessThan(
      at("bun scripts/gate/affected.ts qa"),
    );
    expect(hook).not.toMatch(/\n[^#\n]*machine-lock/);
    expect(hook).not.toMatch(/\n[^#\n]*(until|while true|retry)/);
  });

  test("the old manual lock is never taken by the new code, so its order stays one way", () => {
    expect(readFileSync(CLI, "utf8")).not.toContain("lianki-push.lock");
    expect(hook).not.toContain("lianki-push.lock");
  });
});
