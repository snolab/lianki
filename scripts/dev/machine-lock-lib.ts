/**
 * The lock itself behind `scripts/dev/machine-lock.ts`: one machine-wide gate
 * for the heavy local test runs, two slots by default (docs/shipping.md, "Two
 * heavy runs at a time").
 * The process side (waiting, the child, signals) is in machine-lock.ts.
 *
 * The lock is one file holding its holder as JSON. It appears by hard link, from
 * a temp file already fully written, so acquiring is atomic and nobody can read a
 * half-written holder. A holder is only ever displaced when it is provably dead:
 * pid gone, zombie, or the pid now belongs to a process with another start time.
 * Age never counts.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

export const LOCK_ENV = "LIANKI_GATE_LOCK";
/** Set for the wrapped command: nested wrappers with this token just run. */
export const TOKEN_ENV = "LIANKI_GATE_TOKEN";

export const PROGRESS_EVERY_MS = 60_000;
/** Only ever a warning: a live holder is not taken over however long it runs. */
export const LONG_HOLD_MS = 30 * 60_000;

export type Holder = {
  token: string;
  pid: number;
  /** `ps` start time, the pid-reuse guard; null where `ps` is unavailable. */
  startTime: string | null;
  worktree: string;
  command: string;
  startedAt: string;
  /** When it got its slot; the wait before it is not running time. */
  acquiredAt?: string;
};

type Env = Record<string, string | undefined>;

/**
 * A fixed path, not os.tmpdir(): that differs per session and per user on macOS
 * ($TMPDIR), and the point is that every worktree on the machine meets here.
 */
export function lockPath(env: Env = process.env, platform: string = process.platform): string {
  const override = env[LOCK_ENV];
  if (override) return override;
  return platform === "win32" ? join(tmpdir(), "lianki-gate.lock") : "/tmp/lianki-gate.lock";
}

/** CI runners have the machine to themselves: nothing changes there. */
export function isCi(env: Env = process.env): boolean {
  const ci = env.CI;
  return !!ci && ci !== "false" && ci !== "0";
}

export type LockArgs = { wholeSuite: boolean; label?: string; command: string[] };

/**
 * `[--whole-suite] [--label <text>] [--] <command...>`: options end at the first
 * `--` or the first word that is not one. The `--` has to be optional, because bun
 * itself drops it when it comes straight after the script's name.
 */
export function parseLockArgs(argv: string[]): LockArgs | { error: string } {
  const out: LockArgs = { wholeSuite: false, command: [] };
  let i = 0;
  for (; i < argv.length && argv[i].startsWith("-"); i++) {
    if (argv[i] === "--") {
      i++;
      break;
    }
    if (argv[i] === "--whole-suite") out.wholeSuite = true;
    else if (argv[i] === "--label" && argv[i + 1] && argv[i + 1] !== "--") out.label = argv[++i];
    else return { error: `bad option ${argv[i]}` };
  }
  out.command = argv.slice(i);
  return out.command.length ? out : { error: "no command given" };
}

/**
 * For `bun test …`: anything after those two words that is not a flag picks
 * files or names, so the run is not the whole suite and must stay fast. A flag
 * with a separate value (`--timeout 9000`) reads as narrowed too; the rare miss
 * is on the fast side.
 */
export function isNarrowedSuite(command: string[]): boolean {
  return command.slice(2).some((a) => !a.startsWith("-"));
}

/** Start time and state of a pid, in one fixed format whatever the caller's locale. */
function psInfo(pid: number): { stat: string; start: string } | null {
  const r = spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const m = r.status === 0 ? /^\s*(\S+)\s+(\S.*\S)\s*$/.exec(r.stdout ?? "") : null;
  return m ? { stat: m[1], start: m[2].replace(/\s+/g, " ") } : null;
}

export function processStartTime(pid: number = process.pid): string | null {
  return psInfo(pid)?.start ?? null;
}

export function makeHolder(command: string): Holder {
  return {
    token: randomBytes(12).toString("hex"),
    pid: process.pid,
    startTime: processStartTime(),
    worktree: process.cwd(),
    command,
    startedAt: new Date().toISOString(),
  };
}

export function isHolderAlive(h: Pick<Holder, "pid" | "startTime">): boolean {
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    // EPERM: it exists, it just belongs to someone else.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const seen = psInfo(h.pid);
  // The pid exists and `ps` cannot say more: never break what may be alive.
  if (!seen) return true;
  // Killed, but its parent has not reaped it: kill(0) still succeeds.
  if (seen.stat.startsWith("Z")) return false;
  return !h.startTime || seen.start === h.startTime;
}

type Seen = { raw: string; holder: Holder | null };

/** The lock's content, or null if there is no lock. `holder` null = not ours to parse. */
export function readLock(path: string): Seen | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const h = JSON.parse(raw);
    if (typeof h?.token === "string" && Number.isInteger(h.pid) && h.pid > 0) {
      return { raw, holder: h as Holder };
    }
  } catch {}
  return { raw, holder: null };
}

function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  // /tmp is shared: O_EXCL so a planted symlink is not followed, and only this user
  // can read or replace it. Another user's run can't read the lock, so it warns and
  // runs unlocked.
  writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Remove a lock seen to be dead, unless someone got there first.
 *
 * Two waiters can see the same dead holder; the slower one must not then delete
 * the faster one's fresh lock. So removal needs a marker named after that exact
 * lock content, and the content is checked again under the marker: only a marker
 * holder may remove this content, so it cannot change between check and removal.
 * A marker can be stranded by a kill inside this tiny window; it is a lock like
 * any other, cleared by the same rule. Returns whether this call removed the lock.
 */
function clearDead(path: string, seen: Seen, me: Holder): boolean {
  const name = createHash("sha256").update(seen.raw).digest("hex").slice(0, 12);
  const marker = `${path}.takeover-${name}`;
  if (!createExclusive(marker, JSON.stringify(me))) {
    const other = readLock(marker);
    if (other && !(other.holder && isHolderAlive(other.holder))) clearDead(marker, other, me);
    return false;
  }
  try {
    if (readLock(path)?.raw !== seen.raw) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(marker, { force: true });
  }
}

export type AcquireResult =
  | { acquired: true; tookOver: Seen[] }
  | { acquired: false; holder: Holder | null; tookOver: Seen[] };

/** One attempt. Not acquired with `holder: null` just means: try again shortly. */
export function tryAcquire(path: string, me: Holder): AcquireResult {
  const tookOver: Seen[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, JSON.stringify(me))) return { acquired: true, tookOver };
    const seen = readLock(path);
    if (!seen) continue;
    if (seen.holder && isHolderAlive(seen.holder)) {
      return { acquired: false, holder: seen.holder, tookOver };
    }
    if (clearDead(path, seen, me)) tookOver.push(seen);
  }
  return { acquired: false, holder: null, tookOver };
}

/** Removes the lock only if it is still this token's. */
export function release(path: string, token: string): void {
  if (readLock(path)?.holder?.token === token) rmSync(path, { force: true });
}

/** This process runs inside a live holder's run: `token` came from its wrapper. */
export function isReentrant(path: string, token: string | undefined): boolean {
  if (!token) return false;
  const holder = readLock(path)?.holder;
  return holder?.token === token && isHolderAlive(holder);
}

// ── Admission by load: the gate admits runs while the machine has room ───────
//
// Not a fixed number of runs. A run is admitted when nothing else holds the
// gate (always at least one, so nobody starves), or else only while the machine
// has room: 1-minute load average under LOAD_RATIO x cores AND free + inactive
// memory at least MIN_FREE_GB AND the newest holder has run SETTLE_S, because
// the load average lags and a burst of waiters must not all see the same idle
// moment. The only count is a safety cap, MAX_RUNS = the core count.
//
// Each run holds one slot file with exactly the rules above; slot 1 is the
// original path, so a wrapper from before admission (another branch's checkout)
// still meets this one there.

export const MAX_RUNS_ENV = "LIANKI_GATE_MAX_RUNS";
export const LOAD_RATIO_ENV = "LIANKI_GATE_LOAD_RATIO";
export const MIN_FREE_GB_ENV = "LIANKI_GATE_MIN_FREE_GB";
export const SETTLE_S_ENV = "LIANKI_GATE_SETTLE_S";

export type Rules = { maxRuns: number; loadRatio: number; minFreeBytes: number; settleMs: number };
export type Room = { load: number; cores: number; availBytes: number | null };

const GB = 1024 ** 3;
const num = (v: string | undefined, ok: (n: number) => boolean, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && ok(n) ? n : fallback;
};

/** The admission thresholds: defaults, each overridable by its environment variable. */
export function gateRules(env: Env = process.env, cores: number = availableParallelism()): Rules {
  return {
    maxRuns: Math.floor(num(env[MAX_RUNS_ENV], (n) => n >= 1, Math.max(1, cores))),
    loadRatio: num(env[LOAD_RATIO_ENV], (n) => n > 0, 0.9),
    minFreeBytes: num(env[MIN_FREE_GB_ENV], (n) => n >= 0, 2) * GB,
    settleMs: num(env[SETTLE_S_ENV], (n) => n >= 0, 15) * 1000,
  };
}

/** Free + inactive + speculative pages from `vm_stat`, in bytes; null if unreadable. */
export function parseVmStat(text: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1]);
  const sum = pages("free") + pages("inactive") + (pages("speculative") || 0);
  return Number.isFinite(page) && Number.isFinite(sum) ? sum * page : null;
}

/** The machine now. Memory: vm_stat on macOS (os.freemem leaves out inactive pages). */
export function measureRoom(platform: string = process.platform): Room {
  let availBytes: number | null = null;
  try {
    if (platform === "darwin") {
      const r = spawnSync("vm_stat", { encoding: "utf8" });
      availBytes = r.status === 0 ? parseVmStat(r.stdout ?? "") : null;
    } else availBytes = freemem();
  } catch {}
  return { load: loadavg()[0], cores: availableParallelism(), availBytes };
}

/** When a holder got its slot (a holder from before admission only has startedAt). */
export const heldSince = (h: Holder) => Date.parse(h.acquiredAt ?? h.startedAt);

export type Decision = { admit: boolean; why: string };

const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;

/** May one more run start now, beside `others`? `why` is what a waiter prints. */
export function admission(others: Holder[], room: Room, rules: Rules, now: number): Decision {
  if (!others.length) return { admit: true, why: "nothing else is running" };
  if (others.length >= rules.maxRuns) {
    return { admit: false, why: `${others.length} runs, the safety cap (${MAX_RUNS_ENV})` };
  }
  const ran = now - Math.max(...others.map(heldSince));
  if (ran < rules.settleMs) {
    const left = Math.ceil((rules.settleMs - ran) / 1000);
    return {
      admit: false,
      why: `the newest run started ${Math.floor(ran / 1000)} s ago; its load shows in ${left} s`,
    };
  }
  const limit = rules.loadRatio * room.cores;
  const load = `load ${room.load.toFixed(1)}/${limit.toFixed(1)}`;
  const mem = room.availBytes === null ? "mem unknown" : `mem ${gb(room.availBytes)} free`;
  if (room.load >= limit) return { admit: false, why: `${load} is too high (${mem})` };
  if (room.availBytes !== null && room.availBytes < rules.minFreeBytes) {
    return { admit: false, why: `${mem}, under ${gb(rules.minFreeBytes)} (${load})` };
  }
  return { admit: true, why: `room: ${load}, ${mem}` };
}

/**
 * Two waiters can be admitted in the same moment. After taking a slot, the one
 * that got it later backs off (gives it up and waits again) while another got
 * one within the settle time before it; ties go by token, so exactly one stays.
 */
export function shouldBackOff(me: Holder, others: Holder[], rules: Rules): boolean {
  const mine = heldSince(me);
  return others.some((o) => {
    const at = heldSince(o);
    const earlier = at < mine || (at === mine && o.token < me.token);
    return earlier && mine - at < rules.settleMs;
  });
}

/** The slot files: `<lock>`, `<lock>.2`, … */
export function slotPaths(base: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => (i === 0 ? base : `${base}.${i + 1}`));
}

/** The live holders of every slot, except `skipToken`'s. */
export function liveHolders(paths: string[], skipToken?: string): Holder[] {
  const out: Holder[] = [];
  for (const p of paths) {
    const h = readLock(p)?.holder;
    if (h && h.token !== skipToken && isHolderAlive(h)) out.push(h);
  }
  return out;
}

export type SlotResult =
  | { acquired: true; path: string; tookOver: Seen[] }
  | { acquired: false; holders: Holder[]; tookOver: Seen[] };

/** One attempt at every slot, in order; the first free one is taken. */
export function tryAcquireSlot(paths: string[], me: Holder): SlotResult {
  const tookOver: Seen[] = [];
  const holders: Holder[] = [];
  for (const path of paths) {
    const r = tryAcquire(path, me);
    tookOver.push(...r.tookOver);
    if (r.acquired) return { acquired: true, path, tookOver };
    if (r.holder) holders.push(r.holder);
  }
  return { acquired: false, holders, tookOver };
}

export type GateIo = {
  say: (line: string) => void;
  pollMs: number;
  roomEveryMs?: number;
  rules?: Rules;
  measure?: () => Room;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Wait for admission, take a slot, return it. The slot files are read every
 * `pollMs`, so a holder leaving is seen at once; load and memory are measured
 * at most every `roomEveryMs` (15 s), and again whenever the holders change.
 */
export async function acquireGate(
  paths: string[],
  base: Holder,
  io: GateIo,
): Promise<{ path: string; me: Holder }> {
  const rules = io.rules ?? gateRules();
  const measure = io.measure ?? (() => measureRoom());
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const roomEvery = io.roomEveryMs ?? 15_000;
  const report = waitReporter(now);
  const started = now();
  let room: Room | null = null;
  let roomAt = -Infinity;
  let lastSet = "";
  let lastWhy = "";
  let waited = false;
  for (;;) {
    const others = liveHolders(paths);
    const set = others.map((h) => h.token).join(",");
    if (others.length && (!room || set !== lastSet || now() - roomAt >= roomEvery)) {
      room = measure();
      roomAt = now();
    }
    lastSet = set;
    const d = admission(others, room ?? { load: 0, cores: 1, availBytes: null }, rules, now());
    if (d.admit) {
      const me: Holder = { ...base, acquiredAt: new Date(now()).toISOString() };
      const r = tryAcquireSlot(paths, me);
      for (const dead of r.tookOver) {
        const who = dead.holder ? describeHolder(dead.holder) : "unreadable lock file";
        io.say(`took over from a dead holder: ${who}`);
      }
      if (r.acquired) {
        if (!shouldBackOff(me, liveHolders(paths, me.token), rules)) {
          if (waited) {
            const s = Math.round((now() - started) / 1000);
            io.say(`admitted at ${jst(now())}, after ${s} s (${d.why})`);
          }
          return { path: r.path, me };
        }
        release(r.path, me.token);
      }
    }
    waited = true;
    if (!d.admit && d.why.replace(/\d+/g, "#") !== lastWhy) io.say(`waiting: ${d.why}`);
    lastWhy = d.admit ? "" : d.why.replace(/\d+/g, "#");
    for (const line of report(others)) io.say(line);
    await sleep(io.pollMs * (0.75 + Math.random() / 2));
  }
}

/** Inside a live holder's run, whichever slot it holds. */
export function isReentrantAny(paths: string[], token: string | undefined): boolean {
  return paths.some((p) => isReentrant(p, token));
}

/** A time for the owner: JST, labelled. */
export function jst(ms: number): string {
  return `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19).replace("T", " ")} JST`;
}

export function describeHolder(h: Holder): string {
  return `pid ${h.pid}, ${h.worktree}, \`${h.command}\`, started ${jst(Date.parse(h.startedAt))}`;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

/**
 * What a waiter prints after each failed attempt: each holder once, progress at
 * most once a minute, and one warning for a holder running very long.
 */
export function waitReporter(now: () => number = Date.now) {
  const started = now();
  let lastProgress = started;
  const named = new Set<string>();
  const warned = new Set<string>();
  /** `seen`: the live holder, or every slot's live holder. */
  return (seen: Holder | Holder[] | null): string[] => {
    const lines: string[] = [];
    const at = now();
    for (const holder of seen ? [seen].flat() : []) {
      if (!named.has(holder.token)) {
        named.add(holder.token);
        lines.push(`held by ${describeHolder(holder)}; waiting`);
      }
      const ran = at - Date.parse(holder.startedAt);
      if (ran >= LONG_HOLD_MS && !warned.has(holder.token)) {
        warned.add(holder.token);
        lines.push(
          `warning: pid ${holder.pid} has been running ${minutes(ran)} min. It is alive, so it is not taken over; if it is stuck, look at it (ps -p ${holder.pid}).`,
        );
      }
    }
    if (at - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = at;
      lines.push(`still waiting, ${minutes(at - started)} min so far`);
    }
    return lines;
  };
}
