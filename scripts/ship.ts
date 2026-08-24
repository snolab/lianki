#!/usr/bin/env bun
import { execSync } from "child_process";

const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();
const stream = (cmd: string) => execSync(cmd, { stdio: "inherit" });
const die = (msg: string): never => {
  console.error(`ship: ${msg}`);
  process.exit(1);
};

if (run("git branch --show-current") !== "main") die("must be on main");

run("git fetch origin");
if (run("git rev-list --count origin/main..HEAD") === "0") die("no commits to ship");

const branch = `ship/${run("git rev-parse --short HEAD")}`;
run(`git branch -f ${branch} HEAD`);
stream(`git push origin ${branch}`);
stream(`gh pr create --base main --head ${branch} --fill`);

const pr = run(`gh pr view ${branch} --json number --jq .number`);
stream(`gh pr merge ${pr} --auto --squash`);
if (!run(`gh pr view ${pr} --json autoMergeRequest --jq .autoMergeRequest`))
  die(`auto-merge not armed on #${pr} — check the repo's "Allow auto-merge" setting`);

// gh exits 1 if no required check has registered yet, so wait for them to appear.
for (let i = 0; i < 30; i++) {
  const checks = run(
    `gh pr view ${pr} --json statusCheckRollup --jq '[.statusCheckRollup[]?.name] | length'`,
  );
  if (Number(checks) > 0) break;
  execSync("sleep 5");
}
stream(`gh pr checks ${pr} --watch --required --interval 20`);

// Auto-merge lands a few seconds after the last check goes green.
let merged = false;
for (let i = 0; i < 40; i++) {
  if (run(`gh pr view ${pr} --json state --jq .state`) === "MERGED") {
    merged = true;
    break;
  }
  execSync("sleep 5");
}
if (!merged) die(`#${pr} did not merge`);

run("git fetch origin");
stream("git reset --keep origin/main");
run(`git branch -D ${branch}`);
stream(`git push origin --delete ${branch}`);
console.log(`ship: #${pr} merged to main`);
