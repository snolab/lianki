#!/usr/bin/env bun
/**
 * The full-QA hold and the revert PR (docs/shipping.md, "Full QA and the
 * deploy hold"). Logic in full-qa-lib.ts; this file talks to GitHub.
 *
 *   bun scripts/ci/full-qa.ts trigger           # a push to main: start Full QA now, later or not
 *   bun scripts/ci/full-qa.ts hold              # deploy-worker: may main deploy?
 *   bun scripts/ci/full-qa.ts lifts <run id>    # Full QA, green: does this run lift a hold?
 *   bun scripts/ci/full-qa.ts lifted <run id> <sha>  # deploy-worker: is that lift genuine?
 *   bun scripts/ci/full-qa.ts revert <sha>      # Full QA went red at <sha>: open a revert PR
 *
 * `hold` and `lifts` write `deploy=true|false` (and `reason=`) to
 * $GITHUB_OUTPUT. `hold` also starts a full run when main is held and none is
 * queued, so a fix on main is tested at once.
 * Needs GH_TOKEN (the workflow's token: actions read/write, contents and
 * pull-requests write for `revert`).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { QA_FULL, matchesAny } from "../gate/affected-lib";
import {
  coveredSha,
  decideTrigger,
  holdState,
  lastGreenSha,
  liftIsGenuine,
  liftsHold,
  pending,
  triggerConfig,
  type Run,
} from "./full-qa-lib";

const REPO = process.env.GITHUB_REPOSITORY || "snolab/lianki";
const WORKFLOW = "nightly-qa.yml";

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function must(cmd: string, args: string[]) {
  const r = run(cmd, args);
  if (!r.ok) throw new Error(`${cmd} ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/** Full QA's runs on main, newest first. */
function fullRuns(): Run[] {
  const out = must("gh", [
    "api",
    `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=30`,
    "--jq",
    ".workflow_runs",
  ]);
  return JSON.parse(out) as Run[];
}

function output(kv: Record<string, string>) {
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v.replace(/\n/g, " ")}`);
  for (const l of lines) console.log(l);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

const [what, arg] = process.argv.slice(2);

function startFullQa(why: string) {
  const d = run("gh", ["workflow", "run", WORKFLOW, "-R", REPO, "--ref", "main"]);
  console.log(d.ok ? `started Full QA on main: ${why}` : `could not start Full QA: ${d.err}`);
  if (!d.ok) process.exit(1);
}

if (what === "trigger") {
  const runs = fullRuns();
  const base = coveredSha(runs);
  const head = must("git", ["rev-parse", "HEAD"]);
  if (!base) {
    startFullQa("no green full run on record");
    process.exit(0);
  }
  const shas = must("git", ["rev-list", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  const changed = must("git", ["diff", "--name-only", "--no-renames", base, head])
    .split("\n")
    .filter(Boolean);
  const risky = changed.find((f) => matchesAny(f, QA_FULL)) ?? null;
  const oldest = shas.length
    ? Number(must("git", ["log", "-1", "--format=%ct", shas[shas.length - 1]])) * 1000
    : Date.now();
  const c = triggerConfig(process.env);
  const t = decideTrigger(
    { untested: shas.length, risky, oldestUntestedMs: oldest, nowMs: Date.now() },
    c,
  );
  console.log(`full QA trigger: ${t.action} — ${t.reason} (covered up to ${base.slice(0, 7)})`);
  if (t.action === "now") startFullQa(t.reason);
  if (t.action === "debounce") {
    // A newer push cancels this job (its concurrency group) before the wait ends.
    await new Promise((r) => setTimeout(r, t.waitMin * 60_000));
    startFullQa(`merges quiet for ${t.waitMin} min`);
  }
} else if (what === "hold") {
  const runs = fullRuns();
  const h = holdState(runs);
  if (!h.held) {
    output({ deploy: "true", reason: "the latest full QA run on main is green" });
  } else {
    const why = `full QA is red on main since ${h.run.head_sha.slice(0, 7)} (${h.run.html_url})`;
    if (!pending(runs)) startFullQa("main is held");
    output({ deploy: "false", reason: why });
  }
} else if (what === "lifts") {
  const lifts = liftsHold(fullRuns(), Number(arg));
  output({
    deploy: String(lifts),
    reason: lifts
      ? "a green full QA run lifts the hold"
      : "a green full QA run with no hold to lift: CI already deployed this",
  });
} else if (what === "lifted") {
  const sha = process.argv[4] ?? "";
  const r = JSON.parse(must("gh", ["api", `repos/${REPO}/actions/runs/${arg}`]));
  const jobs = JSON.parse(
    must("gh", ["api", `repos/${REPO}/actions/runs/${arg}/jobs?per_page=50`, "--jq", ".jobs"]),
  );
  const why = liftIsGenuine(r, jobs, sha);
  output(
    why
      ? { deploy: "false", reason: `not a genuine lift: ${why}` }
      : {
          deploy: "true",
          reason: `Full QA run ${arg} passed at ${sha.slice(0, 7)} and lifts the hold`,
        },
  );
} else if (what === "revert") {
  const red = arg;
  const green = lastGreenSha(fullRuns());
  if (!red || !green) {
    console.log(`revert: nothing to do (red ${red}, last green ${green ?? "none"})`);
    process.exit(0);
  }
  // main is linear (squash merges): every commit since the last green run, newest first.
  const shas = must("git", ["rev-list", `${green}..${red}`])
    .split("\n")
    .filter(Boolean);
  if (!shas.length) {
    console.log("revert: no commits since the last green run (a flake or drift, not a change)");
    process.exit(0);
  }
  const branch = `revert/full-qa-${red.slice(0, 7)}`;
  if (run("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]).ok) {
    console.log(`revert: ${branch} exists already`);
    process.exit(0);
  }
  must("git", ["config", "user.name", "github-actions[bot]"]);
  must("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  must("git", ["checkout", "-b", branch, red]);
  const r = run("git", ["revert", "--no-edit", ...shas]);
  if (!r.ok) {
    run("git", ["revert", "--abort"]);
    console.log(
      `::warning title=No revert PR::the commits since ${green.slice(0, 7)} do not revert cleanly`,
    );
    output({ pr: "" });
    process.exit(0);
  }
  must("git", ["push", "origin", branch]);
  const list = must("git", ["log", "--format=- %h %s", `${green}..${red}`]);
  const body = [
    `Full QA went red on main at ${red.slice(0, 7)}; the last green run was at ${green.slice(0, 7)}.`,
    "",
    "This reverts every commit since then:",
    "",
    list,
    "",
    'Merge it only if the failure is real and no fix is coming soon. Deploys are held until full QA is green again (docs/shipping.md, "Full QA and the deploy hold").',
    "",
    "A PR opened by the workflow token gets no CI of its own: push to the branch (or close and reopen) to start the checks.",
  ].join("\n");
  const title = `revert: commits since the last green full QA (${green.slice(0, 7)}..${red.slice(0, 7)})`;
  const made = run("gh", [
    "pr",
    "create",
    "-R",
    REPO,
    "--head",
    branch,
    "--base",
    "main",
    "--title",
    title,
    "--body",
    body,
  ]);
  // The workflow token may open PRs only when the repo allows it (Settings →
  // Actions → "Allow GitHub Actions to create and approve pull requests").
  // Without that, the branch is pushed and the alert carries the one-tap link.
  const pr = made.ok
    ? made.out
    : `https://github.com/${REPO}/compare/main...${branch}?expand=1 (branch pushed; open the PR there)`;
  if (!made.ok) console.log(`::warning title=Revert PR not opened::${made.err}`);
  output({ pr });
} else {
  console.error(
    "usage: bun scripts/ci/full-qa.ts trigger | hold | lifts <run id> | lifted <run id> <sha> | revert <sha>",
  );
  process.exit(2);
}
