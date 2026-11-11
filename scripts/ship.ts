#!/usr/bin/env bun
import { execSync } from "child_process";
import type { ProgressEntry } from "../lib/progress";
import { BASE } from "./dev/eval-socket";
import { postProgress, progressToken } from "./dev/progress-client";
import { prReport, shipNode } from "./ship-node";

const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();
const stream = (cmd: string) => execSync(cmd, { stdio: "inherit" });
const die = (msg: string): never => {
  console.error(`ship: ${msg}`);
  process.exit(1);
};

if (run("git branch --show-current") !== "main") die("must be on main");
// The node the PR goes on (scripts/ship-node.ts): --node, LIANKI_TASK_PATH, a
// "Tree: /path" line in the commit message.
const node = shipNode({
  argv: process.argv.slice(2),
  env: process.env,
  commitMessage: run("git log -1 --format=%B"),
});
if (node && "error" in node) die(node.error);
const target = node && !("error" in node) ? node : null;

run("git fetch origin");
if (run("git rev-list --count origin/main..HEAD") === "0") die("no commits to ship");

const branch = `ship/${run("git rev-parse --short HEAD")}`;
run(`git branch -f ${branch} HEAD`);
stream(`git push origin ${branch}`);
stream(`gh pr create --base main --head ${branch} --fill`);

const pr = run(`gh pr view ${branch} --json number --jq .number`);
await attachPr(Number(pr));
stream(`gh pr merge ${pr} --auto --squash`);
if (!run(`gh pr view ${pr} --json autoMergeRequest --jq .autoMergeRequest`))
  die(`auto-merge not armed on #${pr} — check the repo's "Allow auto-merge" setting`);

// gh exits 1 if no required check has registered yet, so wait for them to appear.
// Double quotes around the jq filter, not single: execSync goes through cmd.exe
// on Windows, which does not treat single quotes as quoting and split the
// filter at its `|` ("'length'' is not recognized as an internal or external
// command"). Double quotes are honoured by both shells and nothing inside
// needs POSIX-only escaping. Same reason `sleep` is Bun.sleepSync, not a shell
// command.
for (let i = 0; i < 30; i++) {
  const checks = run(
    `gh pr view ${pr} --json statusCheckRollup --jq "[.statusCheckRollup[]?.name] | length"`,
  );
  if (Number(checks) > 0) break;
  Bun.sleepSync(5000);
}
stream(`gh pr checks ${pr} --watch --required --interval 20`);

// Auto-merge lands a few seconds after the last check goes green.
let merged = false;
for (let i = 0; i < 40; i++) {
  if (run(`gh pr view ${pr} --json state --jq .state`) === "MERGED") {
    merged = true;
    break;
  }
  Bun.sleepSync(5000);
}
if (!merged) die(`#${pr} did not merge`);

run("git fetch origin");
stream("git reset --keep origin/main");
run(`git branch -D ${branch}`);
stream(`git push origin --delete ${branch}`);
console.log(`ship: #${pr} merged to main`);

/** Put the PR on its node (docs/shipping.md, "The PR on its node"); a failure only warns. */
async function attachPr(n: number) {
  if (!target) {
    console.error(
      `ship: #${n} is on no tree node (no --node, LIANKI_TASK_PATH or "Tree: /path" line); report it: progress.ts … --pr ${n}`,
    );
    return;
  }
  const token = progressToken();
  if (!token) return console.error(`ship: no progress token; #${n} not put on ${target.path}`);
  const tree = await postProgress(BASE, token, "");
  const entry =
    tree instanceof Error
      ? undefined
      : (tree.entries as ProgressEntry[] | undefined)?.find((e) => e.id === target.path);
  if (!entry) return console.error(`ship: ${target.path} is not in the tree; #${n} not put on it`);
  const res = await postProgress(BASE, token, "", prReport(entry, n, process.env.LIANKI_AGENT));
  if (res instanceof Error) console.error(`ship: #${n} not put on ${target.path}: ${res.message}`);
  else console.log(`ship: #${n} put on ${target.path} (from the ${target.from})`);
}
