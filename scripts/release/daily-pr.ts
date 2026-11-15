#!/usr/bin/env bun
/**
 * The daily release (docs/shipping.md, "Daily release"): one PR `main` → `prod`
 * a day, "Release YYYY-MM-DD" (UTC), merged once its required check is green.
 * Merging it is the release: deploy-worker.yml deploys `prod`.
 *
 *   bun scripts/release/daily-pr.ts --dry-run   # what it would open, and why
 *   bun scripts/release/daily-pr.ts             # open/update the PR, then merge it when green
 *   options: --base prod --head main --repo snolab/lianki --wait-min 45
 *
 * When prod has changes main lacks (a hot fix PR'd straight to prod), it opens
 * a back-merge PR prod → main instead and releases on a later run.
 *
 * Runs from .github/workflows/daily-release.yml with the workflow token, or
 * locally with your own `gh` sign-in. Logic: ./daily-pr-lib.ts.
 */
import { spawnSync } from "node:child_process";
import {
  RELEASE_LABEL,
  backMergeBody,
  backMergeTitle,
  checkState,
  needsQueue,
  parseArgs,
  plan,
  prAction,
  releaseBody,
  releaseTitle,
  retryable,
  staleComment,
  utcDate,
  type CheckRun,
  type Commit,
  type OpenPr,
} from "./daily-pr-lib";

const args = parseArgs(process.argv.slice(2), process.env);
const { repo, dryRun } = args;
const inActions = process.env.GITHUB_ACTIONS === "true";

function run(cmd: string, a: string[]) {
  const r = spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function must(cmd: string, a: string[]): string {
  const r = run(cmd, a);
  if (!r.ok) die(`${cmd} ${a.join(" ")}: ${r.err || r.out}`);
  return r.out;
}
function die(msg: string): never {
  console.log(`::error title=Daily release::${msg}`);
  process.exit(1);
}
const sleep = (s: number) => Bun.sleepSync(s * 1000);

const today = utcDate(new Date());
const { base, head } = args;

if (!run("git", ["fetch", "--quiet", "origin", head]).ok) die(`cannot fetch ${head}`);
if (!run("git", ["fetch", "--quiet", "origin", base]).ok)
  die(
    `the branch \`${base}\` does not exist on origin. Create it from main once (git push origin origin/main:refs/heads/${base}); this workflow never creates it.`,
  );
const B = `origin/${base}`;
const H = `origin/${head}`;

// Would merging prod into main change main? Same tree = nothing of prod's own.
const merged = run("git", ["merge-tree", "--write-tree", H, B]);
const prodHasOwn =
  !merged.ok || merged.out.split("\n")[0] !== must("git", ["rev-parse", `${H}^{tree}`]);
const mainAhead = Number(must("git", ["rev-list", "--count", `${B}..${H}`])) > 0;
const p = plan({ prodExists: true, prodHasOwn, mainAhead });
console.log(`daily release ${today}: ${p.kind}${"reason" in p ? ` (${p.reason})` : ""}`);
if (p.kind === "nothing") process.exit(0);

const isBack = p.kind === "back-merge";
// The PR's base and head: release main → prod, back-merge prod → main.
const prBase = isBack ? head : base;
const prHead = isBack ? base : head;

function commits(range: string[]): Commit[] {
  const out = must("git", ["log", "--no-merges", "--format=%H%x09%s", ...range]);
  return out
    ? out.split("\n").map((l) => {
        const [sha, ...s] = l.split("\t");
        return { sha, subject: s.join("\t") };
      })
    : [];
}

let list: Commit[];
if (isBack) {
  // prod's own commits, less those an earlier back-merge already carried.
  const last = run("gh", [
    "pr",
    "list",
    "-R",
    repo,
    "--state",
    "merged",
    "--base",
    prBase,
    "--head",
    prHead,
    "--limit",
    "1",
    "--json",
    "headRefOid",
    "--jq",
    ".[0].headRefOid // empty",
  ]).out;
  const known = last && run("git", ["cat-file", "-e", last]).ok ? [`^${last}`] : [];
  list = commits([B, `^${H}`, ...known]);
} else {
  list = commits([`${B}..${H}`]);
}

const title = isBack ? backMergeTitle(today) : releaseTitle(today);
const body = isBack
  ? backMergeBody({ date: today, base: prBase, head: prHead, commits: list })
  : releaseBody({ date: today, base: prBase, head: prHead, commits: list });

const open: OpenPr | undefined =
  JSON.parse(
    must("gh", [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--base",
      prBase,
      "--head",
      prHead,
      "--json",
      "number,title,url",
      "--jq",
      ".[0] // null",
    ]) || "null",
  ) ?? undefined;
const action = prAction(open, today);

if (dryRun) {
  console.log(
    `dry run: would ${action.kind === "create" ? "open" : `update #${open!.number}`} ${prHead} → ${prBase}`,
  );
  console.log(`\n${title}\n\n${body}`);
  process.exit(0);
}

let number: number;
let url: string;
if (action.kind === "create") {
  const made = run("gh", [
    "pr",
    "create",
    "-R",
    repo,
    "--base",
    prBase,
    "--head",
    prHead,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (!made.ok)
    die(
      `could not open the PR (${made.err}). The workflow token needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". Compare: https://github.com/${repo}/compare/${prBase}...${prHead}?expand=1`,
    );
  url = made.out.split("\n").pop()!;
  number = Number(url.split("/").pop());
} else {
  number = open!.number;
  url = open!.url;
  must("gh", ["pr", "edit", String(number), "-R", repo, "--title", title, "--body", body]);
  if (action.stale)
    must("gh", [
      "pr",
      "comment",
      String(number),
      "-R",
      repo,
      "--body",
      staleComment(action.since, today, p.kind),
    ]);
}
console.log(`daily release: ${url}`);
// The label is a nicety: a missing label or permission must not stop the release.
if (!isBack) {
  run("gh", [
    "label",
    "create",
    RELEASE_LABEL,
    "-R",
    repo,
    "--color",
    "B60205",
    "--description",
    "Daily release to prod",
  ]);
  const l = run("gh", ["pr", "edit", String(number), "-R", repo, "--add-label", RELEASE_LABEL]);
  if (!l.ok) console.log(`::warning title=No release label::${l.err}`);
}

// Wait for the required check on the head commit (CI on main/prod already
// runs it on every push), then merge exactly that commit.
const view = JSON.parse(
  must("gh", ["pr", "view", String(number), "-R", repo, "--json", "id,headRefOid"]),
);
const sha: string = view.headRefOid;
const deadline = Date.now() + args.waitMin * 60_000;
for (;;) {
  const runs: CheckRun[] = JSON.parse(
    must("gh", [
      "api",
      `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      "--jq",
      ".check_runs",
    ]),
  );
  const state = checkState(runs);
  if (state === "success") break;
  if (state === "failure")
    die(`the required check failed on ${sha.slice(0, 7)}; #${number} stays open`);
  if (Date.now() > deadline)
    die(
      `the required check is ${state} on ${sha.slice(0, 7)} after ${args.waitMin} min; #${number} stays open`,
    );
  sleep(30);
}

const gql = (query: string) => run("gh", ["api", "graphql", "-f", `query=${query}`]);
const merge = (method: "MERGE" | "SQUASH") =>
  gql(
    `mutation { mergePullRequest(input: {pullRequestId: "${view.id}", mergeMethod: ${method}, expectedHeadOid: "${sha}"}) { pullRequest { state } } }`,
  );
const enqueue = () =>
  gql(
    `mutation { enqueuePullRequest(input: {pullRequestId: "${view.id}", expectedHeadOid: "${sha}"}) { mergeQueueEntry { position } } }`,
  );

// A release merges with a merge commit, so main's commits become prod's and
// the next release lists only what is new. A back-merge goes into main's merge
// queue (squash, as every PR to main).
let r = isBack ? enqueue() : merge("MERGE");
let queued = isBack;
if (!r.ok && !isBack && needsQueue(r.err + r.out)) {
  queued = true;
  r = enqueue();
}
for (let i = 0; !r.ok && retryable(r.err + r.out) && i < 10; i++) {
  sleep(30);
  r = queued ? enqueue() : merge("MERGE");
}
if (!r.ok) die(`could not ${queued ? "enqueue" : "merge"} #${number}: ${r.err || r.out}`);
console.log(`daily release: #${number} ${queued ? "queued" : "merged"}`);

// A merge made with the workflow token starts no push workflows, so CI (and
// the deploy after it) would not run: start the deploy here. Merged with a
// person's sign-in, the push to prod starts CI and the deploy by itself.
if (!queued && inActions) {
  must("gh", ["workflow", "run", "deploy-worker.yml", "-R", repo, "--ref", base]);
  console.log(`::notice title=Released::#${number} merged into ${base}; Deploy Worker started`);
}
