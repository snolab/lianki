#!/usr/bin/env bun
/**
 * Re-record scripts/qa/suite-timings.json from CI: the median seconds of each
 * qa:all suite over recent green merge-queue runs, so the shards stay balanced
 * (scripts/qa/shard.mjs; docs/shipping.md, "qa:all in shards").
 *
 *   bun scripts/qa/record-timings.ts            # the last 8 green merge-queue runs
 *   bun scripts/qa/record-timings.ts 4266… 4266…  # these runs
 *
 * Reads the `qa:all timing <id> <seconds>` lines gate-suites.ts prints after
 * each suite. A suite seen in no run keeps its old figure.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { median, timingsFromLog } from "./shard.mjs";

const FILE = "scripts/qa/suite-timings.json";
const REPO = "snolab/lianki";

function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

if (import.meta.main) {
  let runs = process.argv.slice(2);
  if (!runs.length) {
    const list = JSON.parse(
      gh([
        "run",
        "list",
        "-R",
        REPO,
        "--workflow",
        "ci.yml",
        "--event",
        "merge_group",
        "--status",
        "success",
        "--limit",
        "8",
        "--json",
        "databaseId",
      ]),
    ) as { databaseId: number }[];
    runs = list.map((r) => String(r.databaseId));
  }
  const seen: Record<string, number[]> = {};
  const used: string[] = [];
  for (const id of runs) {
    const t: Record<string, number> = timingsFromLog(gh(["run", "view", id, "-R", REPO, "--log"]));
    if (!Object.keys(t).length) continue;
    used.push(id);
    for (const [k, v] of Object.entries(t)) (seen[k] ??= []).push(v);
  }
  if (!used.length) {
    console.error("record-timings: no `qa:all timing` lines in those runs");
    process.exit(1);
  }
  const file = JSON.parse(readFileSync(FILE, "utf8"));
  for (const [k, xs] of Object.entries(seen)) file.seconds[k] = Math.round(median(xs) * 10) / 10;
  file.recorded = `${new Date().toISOString().slice(0, 10)}, runs ${used.join(" ")}`;
  writeFileSync(FILE, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`record-timings: ${Object.keys(seen).length} suites from ${used.length} run(s)`);
}
