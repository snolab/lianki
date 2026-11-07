#!/usr/bin/env bun
/**
 * One heavy test run at a time on this machine, across all worktrees: time-
 * sensitive tests time out when parallel agents run the suites at once.
 *
 *   bun scripts/dev/machine-lock.ts [--whole-suite] [--label <text>] -- <command...>
 *
 * Waits for the lock, runs the command, passes on its exit code. The rules are
 * in docs/shipping.md, "One heavy run at a time"; the lock in machine-lock-lib.ts.
 * This file is the process side, tested through real child processes
 * (unit/machine-lock.test.ts).
 *
 * --whole-suite: the command is `bun test`; take the lock only if no file or name
 * narrows it, so `bun run test:unit unit/x.test.ts` stays as fast as `bun test`.
 *
 * Runs without the lock: CI, and inside a run that already holds it (the same
 * token, handed down in the environment). If the lock file cannot be used at all
 * it warns and runs unlocked: a broken /tmp must not push anyone to --no-verify.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import {
  type Holder,
  TOKEN_ENV,
  describeHolder,
  isCi,
  isNarrowedSuite,
  isReentrant,
  jst,
  lockPath,
  makeHolder,
  parseLockArgs,
  release,
  tryAcquire,
  waitReporter,
} from "./machine-lock-lib";

const say = (line: string) => console.error(`machine-lock: ${line}`);

const parsed = parseLockArgs(process.argv.slice(2));
if ("error" in parsed) {
  say(`${parsed.error}\nusage: machine-lock.ts [--whole-suite] [--label <text>] -- <command...>`);
  process.exit(2);
}
const { command, label, wholeSuite } = parsed;

const path = lockPath();
const pollMs = Number(process.env.LIANKI_GATE_POLL_MS) || 3000;
let child: ChildProcess | null = null;
let held: Holder | null = null;

process.on("exit", () => {
  if (!held) return;
  try {
    release(path, held.token);
  } catch {}
});

// A signal goes to the command, and the lock stays held until the command is
// really gone. Waiting, or between acquiring and spawning, there is only us.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (child) child.kill(sig);
    else process.exit(128 + constants.signals[sig]);
  });
}

function run(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(command[0], command.slice(1), { stdio: "inherit", env });
    child = c;
    c.on("error", (e) => {
      say(`cannot run ${command[0]}: ${e.message}`);
      child = null;
      resolve(127);
    });
    c.on("exit", (code, signal) => {
      child = null;
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0));
    });
  });
}

async function acquire(me: Holder): Promise<void> {
  const report = waitReporter();
  const started = Date.now();
  let waited = false;
  for (;;) {
    const r = tryAcquire(path, me);
    for (const dead of r.tookOver) {
      const who = dead.holder ? describeHolder(dead.holder) : "unreadable lock file";
      say(`took over from a dead holder: ${who}`);
    }
    if (r.acquired) {
      held = me;
      if (waited) {
        const s = Math.round((Date.now() - started) / 1000);
        say(`acquired at ${jst(Date.now())}, after ${s} s`);
      }
      return;
    }
    waited = true;
    for (const line of report(r.holder)) say(line);
    await new Promise((done) => setTimeout(done, pollMs * (0.75 + Math.random() / 2)));
  }
}

function needsLock(): boolean {
  if (isCi() || (wholeSuite && isNarrowedSuite(command))) return false;
  try {
    return !isReentrant(path, process.env[TOKEN_ENV]);
  } catch {
    return true;
  }
}

let env: NodeJS.ProcessEnv = process.env;
if (needsLock()) {
  const me = makeHolder(label ?? command.join(" "));
  try {
    await acquire(me);
    env = { ...process.env, [TOKEN_ENV]: me.token };
  } catch (e) {
    say(`warning: cannot use ${path} (${(e as Error).message}); running without the lock`);
  }
}
process.exit(await run(env));
