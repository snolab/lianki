/**
 * qa:all's side of the machine-wide gate (docs/shipping.md, "Admission by load"):
 * run the plain suites at once, the time-sensitive ones (scripts/qa/suites.mjs)
 * only after load-based admission, and write down the machine's state whenever a
 * suite fails, so the thresholds can be tuned from evidence.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import {
  TOKEN_ENV,
  acquireGate,
  gateRules,
  isCi,
  isReentrantAny,
  liveHolders,
  lockPath,
  makeHolder,
  measureRoom,
  release,
  slotPaths,
} from "../dev/machine-lock-lib";

export type Suite = {
  name: string;
  id?: string;
  cmd: string;
  args: string[];
  sensitive: boolean;
  base?: boolean;
  url?: boolean;
};

export const FAILURE_LOG_ENV = "LIANKI_GATE_FAILURE_LOG";
export const failureLogPath = (env: Record<string, string | undefined> = process.env) =>
  env[FAILURE_LOG_ENV] || "/tmp/lianki-gate-failures.jsonl";

/** One line of the failure log: what failed and how busy the machine was. */
export function failureRecord(
  s: Suite,
  exit: number | string,
  durationS: number,
  gateRuns: number,
  room = measureRoom(),
  load = loadavg(),
) {
  return {
    at: new Date().toISOString(),
    suite: s.name,
    sensitive: s.sensitive,
    exit,
    durationS: Math.round(durationS * 10) / 10,
    load1: Math.round(load[0] * 100) / 100,
    load5: Math.round(load[1] * 100) / 100,
    cores: room.cores,
    freeGB: room.availBytes === null ? null : Math.round((room.availBytes / 1024 ** 3) * 10) / 10,
    gateRuns,
    worktree: process.cwd(),
  };
}

/** Runs every suite (failures do not stop the rest); returns [name, passed] in list order. */
export async function runSuites(
  suites: Suite[],
  base: string,
  log: (s: string) => void,
): Promise<[string, boolean][]> {
  const slots = slotPaths(lockPath(), gateRules().maxRuns);
  const done = new Map<string, boolean>();
  const run = (s: Suite, extra: Record<string, string> = {}) => {
    log(`SUITE — ${s.name}${s.sensitive ? " (time-sensitive)" : ""}`);
    const env = { ...process.env, ...extra };
    if (s.base) env.QA_BASE = base;
    if (s.url) env.LIANKI_URL = base;
    const t = Date.now();
    const r = spawnSync(s.cmd, s.args, { stdio: "inherit", env });
    const ok = r.status === 0;
    done.set(s.name, ok);
    // One machine-readable line per suite: scripts/qa/record-timings.ts reads
    // these from CI logs to keep the shards balanced (suite-timings.json).
    console.log(`qa:all timing ${s.id ?? s.name} ${((Date.now() - t) / 1000).toFixed(1)}`);
    if (!ok) {
      try {
        const rec = failureRecord(
          s,
          r.status ?? String(r.signal),
          (Date.now() - t) / 1000,
          liveHolders(slots).length,
        );
        appendFileSync(failureLogPath(), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      } catch {}
    }
  };

  for (const s of suites.filter((x) => !x.sensitive)) run(s);

  const sensitive = suites.filter((x) => x.sensitive);
  if (sensitive.length) {
    let held: { path: string; token: string } | null = null;
    const needs = !isCi() && !isReentrantAny(slots, process.env[TOKEN_ENV]);
    if (needs) {
      log("gate — waiting for room for the time-sensitive suites");
      try {
        const g = await acquireGate(slots, makeHolder(`qa:all time-sensitive suites`), {
          say: (l) => console.error(`machine-lock: ${l}`),
          pollMs: Number(process.env.LIANKI_GATE_POLL_MS) || 3000,
        });
        held = { path: g.path, token: g.me.token };
      } catch (e) {
        console.error(`machine-lock: warning: ${(e as Error).message}; running without the gate`);
      }
    }
    const release_ = () => held && release(held.path, held.token);
    process.on("exit", () => {
      try {
        release_();
      } catch {}
    });
    const extra: Record<string, string> = held ? { [TOKEN_ENV]: held.token } : {};
    for (const s of sensitive) run(s, extra);
    release_();
    held = null;
  }
  return suites.map((s) => [s.name, done.get(s.name) ?? false]);
}
