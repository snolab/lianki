#!/usr/bin/env bun
/**
 * The pre-push gate's test selection (docs/shipping.md, "Only what changed"):
 * run only the unit tests and qa suites the pushed change can reach. CI runs
 * everything (the unit suite with coverage on each PR, qa:all in the merge
 * queue and nightly).
 *
 *   bun scripts/gate/affected.ts unit   # run the selected unit tests
 *   bun scripts/gate/affected.ts qa     # run qa:all with the selected suites
 *   bun scripts/gate/affected.ts plan   # print both selections, run nothing
 *
 * Changed files: the pushed commits (LIANKI_PUSH_SHAS, space-separated; HEAD
 * when unset) against their merge base with origin/main, plus uncommitted edits
 * to tracked files (the tests run on the working tree). LIANKI_GATE_FULL=1
 * forces the full unit suite with coverage and the full qa:all.
 * LIANKI_GATE_CHANGED="lib/a.ts app/b.tsx" stands in for the diff — to ask
 * "what would run if I changed this?" with `plan`.
 *
 * The literals of each code file are cached in node_modules/.cache, keyed by
 * mtime and size, so a rerun reads only the files that changed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  CODE_EXT,
  TEST_FILE,
  affectedBy,
  aliasesFrom,
  buildGraph,
  makeRepo,
  parseJsonc,
  pathLiterals,
  planQa,
  planUnit,
  type QaPlan,
  type UnitPlan,
} from "./affected-lib";
import { SUITES } from "../qa/suites.mjs";

const CACHE = "node_modules/.cache/lianki-affected/literals.json";
const CACHE_VERSION = 1;

function git(args: string[]): string | null {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}
const lines = (s: string | null) => (s ?? "").split("\n").filter(Boolean);

/** Changed paths, or null when there is no merge base to diff against. */
export function changedFiles(env = process.env): string[] | null {
  if (env.LIANKI_GATE_CHANGED) return env.LIANKI_GATE_CHANGED.split(/\s+/).filter(Boolean).sort();
  const shas = (env.LIANKI_PUSH_SHAS || "HEAD").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (const sha of shas) {
    const base = git(["merge-base", sha, "origin/main"])?.trim();
    if (!base) return null;
    const diff = git(["diff", "--name-only", "--no-renames", base, sha]);
    if (diff === null) return null;
    for (const f of lines(diff)) out.add(f);
  }
  for (const f of lines(git(["diff", "--name-only", "--no-renames", "HEAD"]))) out.add(f);
  return [...out].sort();
}

type Cache = { v: number; files: Record<string, [number, number, string[]]> };

function literalsOf(files: string[]): Map<string, string[]> {
  let cache: Cache = { v: CACHE_VERSION, files: {} };
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (c.v === CACHE_VERSION) cache = c;
  } catch {}
  const next: Cache = { v: CACHE_VERSION, files: {} };
  const out = new Map<string, string[]>();
  let read = 0;
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue;
    let st;
    try {
      st = statSync(f);
    } catch {
      continue; // deleted in the working tree
    }
    if (st.size > 2 << 20) continue; // generated bundles
    const hit = cache.files[f];
    const lits =
      hit && hit[0] === st.mtimeMs && hit[1] === st.size
        ? hit[2]
        : (read++, pathLiterals(readFileSync(f, "utf8")));
    next.files[f] = [st.mtimeMs, st.size, lits];
    out.set(f, lits);
  }
  if (read) {
    try {
      mkdirSync("node_modules/.cache/lianki-affected", { recursive: true });
      writeFileSync(CACHE, JSON.stringify(next));
    } catch {}
  }
  return out;
}

export function plan(env = process.env): { changed: string[]; unit: UnitPlan; qa: QaPlan } {
  if (env.LIANKI_GATE_FULL === "1") {
    const reason = "LIANKI_GATE_FULL=1";
    return { changed: [], unit: { mode: "full", reason }, qa: { mode: "full", reason } };
  }
  const changed = changedFiles(env);
  if (!changed) {
    const reason = "no merge base with origin/main (run `git fetch origin main`)";
    return { changed: [], unit: { mode: "full", reason }, qa: { mode: "full", reason } };
  }
  let affected: Map<string, string> | null = null;
  const all = lines(git(["ls-files", "--cached", "--others", "--exclude-standard"]));
  try {
    if (!all.length) throw new Error("git ls-files gave nothing");
    const ts = parseJsonc(readFileSync("tsconfig.json", "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const repo = makeRepo(all, aliasesFrom(ts.compilerOptions.paths));
    affected = affectedBy(buildGraph(repo, literalsOf(all)), changed);
  } catch (e) {
    console.error(`affected: graph failed: ${(e as Error).message}`);
  }
  const tests = all.filter((f) => TEST_FILE.test(f));
  return {
    changed,
    unit: planUnit(changed, affected, tests),
    qa: planQa(changed, affected, SUITES),
  };
}

const MAX_LIST = 25;

function printUnit(p: UnitPlan, changed: string[]) {
  if (p.mode === "full") {
    console.log(`unit: FULL suite with coverage — ${p.reason}`);
    return;
  }
  console.log(
    `unit: ${p.tests.length} of ${p.total} test files reach the ${changed.length} changed file(s)` +
      (p.tests.length ? "" : " — no unit tests to run (CI runs the full suite)"),
  );
  for (const [t, why] of p.tests.slice(0, MAX_LIST)) console.log(`  ${t}  ← ${why}`);
  if (p.tests.length > MAX_LIST) console.log(`  … and ${p.tests.length - MAX_LIST} more`);
}

function printQa(p: QaPlan) {
  if (p.mode === "full") {
    console.log(`qa: FULL qa:all — ${p.reason}`);
    return;
  }
  if (!p.suites.length) {
    console.log(
      `qa: no qa suite matches the change — none run (CI runs qa:all in the merge queue)`,
    );
    return;
  }
  console.log(`qa: ${p.suites.length} of ${p.total} suites`);
  for (const [id, why] of p.suites) console.log(`  ${id}  ← ${why}`);
}

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status ?? 1;
}

if (import.meta.main) {
  const what = process.argv[2];
  const t = Date.now();
  const p = plan();
  const took = `${Date.now() - t} ms`;
  if (what === "plan") {
    if (process.argv.includes("--json")) console.log(JSON.stringify(p, null, 2));
    else {
      console.log(`changed (${p.changed.length}): ${p.changed.slice(0, 10).join(" ")}`);
      printUnit(p.unit, p.changed);
      printQa(p.qa);
      console.log(`(selected in ${took})`);
    }
    process.exit(0);
  }
  if (what === "unit") {
    printUnit(p.unit, p.changed);
    if (p.unit.mode === "full") process.exit(run("bun", ["test", "--coverage"]));
    if (!p.unit.tests.length) process.exit(0);
    process.exit(
      run("bun", [
        "--config=scripts/gate/bunfig.affected.toml",
        "test",
        ...p.unit.tests.map(([f]) => `./${f}`),
      ]),
    );
  }
  if (what === "qa") {
    printQa(p.qa);
    if (p.qa.mode === "full") process.exit(run("bun", ["scripts/qa/qa-all.mjs"]));
    if (!p.qa.suites.length) process.exit(0);
    process.exit(
      run("bun", ["scripts/qa/qa-all.mjs", `--suites=${p.qa.suites.map(([id]) => id).join(",")}`]),
    );
  }
  console.error("usage: bun scripts/gate/affected.ts unit|qa|plan [--json]");
  process.exit(2);
}
