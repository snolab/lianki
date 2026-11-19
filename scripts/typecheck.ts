// Type checking (owner rule, 2026-11-16): tsrs everywhere (oxc-project/tsrs,
// the Rust port of TS 7), and tsc 7 only when tsrs itself breaks.
//
// Exit codes: 0 = no type errors, 1 = config error (tsconfig, -p), 2 = type
// errors. Those three are tsrs's answer and are returned as is — tsc never
// hides a code error. Anything else (a Rust panic exits 101, a signal, a
// missing binary) means tsrs crashed: the check is redone with tsc 7 and its
// result used, with a one-line warning to look at when bumping tsrs.
//
// tsc 7 is the `typescript-7` alias (npm:typescript@7): the plain `typescript`
// devDependency stays on 5.x because Next and intlayer load its JS API.
//
// Usage: bun scripts/typecheck.ts <the same args as tsc> (bun run typecheck
// passes --noEmit).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

/** Run a node_modules launcher (JS) with the running bun: no shell, so Windows runners work too. */
function run(launcher: string, argv = args, quiet = false): number | null {
  return spawnSync(process.execPath, [launcher, ...argv], { stdio: quiet ? "ignore" : "inherit" })
    .status;
}

/** Find node_modules/<path> from the cwd upward (the packages' exports do not expose their bins). */
function find(path: string): string | null {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const f = join(dir, "node_modules", path);
    if (existsSync(f)) return f;
    if (dirname(dir) === dir) return null;
  }
}

const TSRS = find("tsrs/bin/tsrs");
// Ask for the version first: with no binary for this machine the launcher
// exits 1, which would read as a config error.
const rc = TSRS && run(TSRS, ["--version"], true) === 0 ? run(TSRS) : null;
if (rc === 0 || rc === 1 || rc === 2) process.exit(rc);
console.error(
  `typecheck: tsrs ${rc === null ? "could not start or was killed" : `ended with exit ${rc}`}; checking with tsc 7 instead (scripts/typecheck.ts)`,
);
const TSC = find("typescript-7/bin/tsc");
process.exit(TSC ? (run(TSC) ?? 1) : 1);
