/**
 * The pure parts of scripts/dev/preview-follow.ts (docs/dev-whole-page.md,
 * "Following main"): what an event says, one catch-up run as a decision flow
 * over an injected command runner, and the one-run-at-a-time queue. Unit
 * tests drive all of it with a fake git (unit/preview-follow.test.ts).
 */

export type Ran = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<Ran>;

/** Why a run did what it did; one JSON log line each. */
export type Outcome =
  | { kind: "up-to-date"; target: string }
  | { kind: "merged"; target: string; head: string }
  | { kind: "resolved"; target: string; head: string; files: string[] }
  | { kind: "resolve-failed"; target: string; files: string[]; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; reason: string };

export type FollowDeps = {
  /** Runs a command in the merge worktree (tree/preview). */
  run: Runner;
  /** The branch that worktree must be on: the one `serve --follow` takes. */
  branch: string;
  remote?: string;
  main?: string;
  /** The headless agent: resolve the markers in `files` in place. true = it says it did. */
  resolve: (files: string[], target: string) => Promise<boolean>;
  /** `bun scripts/dev/whole-page.ts publish`. */
  publish: () => Promise<void>;
  /** One line to the owner's chat (only when resolving failed). */
  say: (line: string) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * `{"build": "<id>"}` from lianki-push's /api/version/ws (the auto-update
 * socket): the build now serving. Anything else is not news. The id is only
 * a hint that main moved: the run itself asks git, never trusts the message.
 */
export function parseVersionMessage(data: unknown): string | null {
  if (typeof data !== "string" || data.length > 4096) return null;
  try {
    const m = JSON.parse(data) as { build?: unknown };
    return typeof m?.build === "string" && /^[\w.:-]{1,128}$/.test(m.build) ? m.build : null;
  } catch {
    return null;
  }
}

/**
 * A kick from the reference-transaction hook: `POST /kick?sha=<new>`. The
 * sha is informational (logged); a non-hex one is dropped, not fatal.
 */
export function parseKick(url: string): { sha: string | null } {
  const sha = new URL(url, "http://follow").searchParams.get("sha");
  return { sha: sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null };
}

/** Paths of `git merge-tree --write-tree --name-only --no-messages` (first line is the tree). */
export function mergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.split("\n").slice(1);
  const out: string[] = [];
  for (const l of lines) {
    if (!l) break;
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/**
 * Type errors as a set, positions stripped, so a line that moved is not new.
 * `.next/` is generated and ignored. tsgo prints `path(l,c): error TSnnnn: msg`.
 */
export function typeErrors(output: string): Set<string> {
  const out = new Set<string>();
  for (const l of output.split("\n")) {
    const m = /^(.+?)\(\d+,\d+\): (error TS\d+: .*)$/.exec(l.trim());
    if (!m || m[1].startsWith(".next/")) continue;
    out.add(`${m[1]}: ${m[2]}`);
  }
  return out;
}

export function newErrors(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((e) => !before.has(e));
}

/** The instructions the headless agent gets. */
export function resolverPrompt(files: string[], target: string, branch: string): string {
  return [
    `You are resolving a git merge of origin/main (${target.slice(0, 12)}) into ${branch}, in this worktree.`,
    `The merge stopped with conflicts in:`,
    ...files.map((f) => `- ${f}`),
    ``,
    `Rules:`,
    `- Edit ONLY those files, and only the conflicted regions (between <<<<<<< and >>>>>>>).`,
    `- Keep the intent of BOTH sides. Never drop a feature, a test, a doc paragraph or a fix from either side; combine them.`,
    `- Remove every conflict marker. If a file was deleted on one side and changed on the other, keep the file with the change unless the deletion is clearly a move (then apply the change at the new place).`,
    `- Do not run git add, commit, merge, reset, checkout, stash or push; do not touch any other file. The caller verifies and commits.`,
    `- When done, run \`bun run typecheck\` and fix type errors you introduced in those files.`,
    `- If you cannot resolve a conflict with confidence, stop and say so; leave the markers in place.`,
  ].join("\n");
}

const git = (d: FollowDeps, args: string[], timeoutMs?: number) =>
  d.run(["git", ...args], { timeoutMs });
const first = (s: string) => s.trim().split("\n")[0] ?? "";

async function typecheck(d: FollowDeps): Promise<Set<string>> {
  const r = await d.run(["bun", "run", "typecheck"], { timeoutMs: 10 * 60_000 });
  return typeErrors(`${r.stdout}\n${r.stderr}`);
}

const lockChanged = (files: string[]) =>
  files.some((f) => f === "bun.lock" || f === "package.json");

/**
 * One catch-up: fetch main, merge it into the branch, resolve conflicts with
 * the agent when there are any, publish. Never force, never reset, never a
 * branch other than `branch`; a failed resolution is aborted, leaving the
 * branch exactly where it was.
 */
export async function followOnce(d: FollowDeps): Promise<Outcome> {
  const remote = d.remote ?? "origin";
  const main = d.main ?? "main";
  const ref = `${remote}/${main}`;
  const log = d.log ?? (() => {});

  const head = await git(d, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (head.stdout.trim() !== d.branch)
    return {
      kind: "skipped",
      reason: `worktree is on ${head.stdout.trim() || "a detached HEAD"}, not ${d.branch}`,
    };
  for (const special of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    if ((await git(d, ["rev-parse", "-q", "--verify", special])).code === 0)
      return { kind: "skipped", reason: `${special} exists: someone is mid-operation` };
  }
  const dirty = await git(d, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0 || dirty.stdout.trim())
    return { kind: "skipped", reason: "uncommitted changes in the merge worktree" };

  const fetched = await git(d, ["fetch", "--quiet", remote, main], 5 * 60_000);
  if (fetched.code !== 0)
    return { kind: "error", reason: `fetch failed: ${first(fetched.stderr)}` };
  const target = (await git(d, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(target)) return { kind: "error", reason: `no ${ref}` };
  if ((await git(d, ["merge-base", "--is-ancestor", target, "HEAD"])).code === 0)
    return { kind: "up-to-date", target };

  const before = (await git(d, ["rev-parse", "HEAD"])).stdout.trim();
  const incoming = (await git(d, ["diff", "--name-only", `HEAD...${target}`])).stdout
    .split("\n")
    .filter(Boolean);
  const message = `Merge ${ref} (${target.slice(0, 12)}) into ${d.branch}`;
  const tree = await git(d, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "HEAD",
    target,
  ]);
  if (tree.code > 1) return { kind: "error", reason: `merge-tree: ${first(tree.stderr)}` };

  const install = async () => {
    if (!lockChanged(incoming)) return true;
    const r = await d.run(["bun", "install", "--frozen-lockfile"], { timeoutMs: 10 * 60_000 });
    log({ step: "bun install", ok: r.code === 0 });
    return r.code === 0;
  };

  if (tree.code === 0) {
    const m = await git(d, ["merge", "--no-edit", "--no-ff", "-m", message, target]);
    if (m.code !== 0) {
      await git(d, ["merge", "--abort"]);
      return { kind: "error", reason: `clean merge failed: ${first(m.stderr || m.stdout)}` };
    }
    await install();
    await d.publish();
    return { kind: "merged", target, head: (await git(d, ["rev-parse", "HEAD"])).stdout.trim() };
  }

  // Conflicts. Errors the branch already has are not the resolver's: take them first.
  const predicted = mergeTreeConflicts(tree.stdout);
  const baseline = await typecheck(d);
  const untrackedBefore = (await git(d, ["ls-files", "--others", "--exclude-standard"])).stdout;
  await git(d, ["merge", "--no-edit", "--no-ff", "-m", message, target]);
  const files = (await git(d, ["diff", "--name-only", "--diff-filter=U"])).stdout
    .split("\n")
    .filter(Boolean);
  const fail = async (reason: string): Promise<Outcome> => {
    // Back to exactly where the branch was: abort the merge, or, if it was
    // concluded behind our back, step back with --keep (refuses to lose work).
    if ((await git(d, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0)
      await git(d, ["merge", "--abort"]);
    else if (
      (await git(d, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() === d.branch &&
      (await git(d, ["rev-parse", "HEAD"])).stdout.trim() !== before
    )
      await git(d, ["reset", "--keep", before]);
    // The tracked tree was clean when the run began, so an edit still left
    // after the abort is the resolver's, outside the merge: put it back.
    const left = (await git(d, ["diff", "--name-only", "HEAD"])).stdout.split("\n").filter(Boolean);
    if (left.length) {
      await git(d, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...left]);
      log({ step: "restored files the resolver edited outside the merge", files: left });
    }
    const list = (files.length ? files : predicted).slice(0, 6).join(", ");
    const more = (files.length || predicted.length) > 6 ? " …" : "";
    await d.say(
      `【小可】预览版跟进 main（${target.slice(0, 7)}）合并冲突，自动解决失败，已撤销合并：${list}${more}（${reason}）`,
    );
    return { kind: "resolve-failed", target, files: files.length ? files : predicted, reason };
  };
  if (!files.length) return fail("merge stopped without conflicted files");

  let said = false;
  try {
    said = await d.resolve(files, target);
  } catch (e) {
    log({ step: "resolver threw", error: String(e) });
  }
  if (!said) return fail("the resolver gave up");

  // It must not have committed, switched, or left the merge.
  if ((await git(d, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() !== d.branch)
    return fail("the branch changed during resolution");
  if ((await git(d, ["rev-parse", "HEAD"])).stdout.trim() !== before)
    return fail("HEAD moved during resolution");
  if ((await git(d, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code !== 0)
    return fail("the merge was ended during resolution");
  // It must have touched only the conflicted files.
  const touched = (await git(d, ["diff", "--name-only"])).stdout.split("\n").filter(Boolean);
  const stray = touched.filter((f) => !files.includes(f));
  if (stray.length)
    return fail(`edited files outside the conflict: ${stray.slice(0, 3).join(", ")}`);
  const untrackedAfter = (await git(d, ["ls-files", "--others", "--exclude-standard"])).stdout;
  if (untrackedAfter !== untrackedBefore) return fail("created untracked files");
  // No marker left anywhere in them.
  const grep = await git(d, [
    "grep",
    "-l",
    "-I",
    "-E",
    "^(<{7} |={7}$|>{7} |[|]{7} )",
    "--",
    ...files,
  ]);
  if (grep.code === 0) return fail(`conflict markers left in ${first(grep.stdout)}`);

  const added = await git(d, ["add", "-A", "--", ...files]);
  if (added.code !== 0) return fail(`git add: ${first(added.stderr)}`);
  if (!(await install())) return fail("bun install --frozen-lockfile failed");
  const fresh = newErrors(baseline, await typecheck(d));
  if (fresh.length) return fail(`${fresh.length} new type error(s): ${fresh[0].slice(0, 160)}`);
  const c = await git(d, ["commit", "-m", message]);
  if (c.code !== 0) return fail(`commit: ${first(c.stderr || c.stdout)}`);
  await d.publish();
  return {
    kind: "resolved",
    target,
    head: (await git(d, ["rev-parse", "HEAD"])).stdout.trim(),
    files,
  };
}

/**
 * One run at a time. Events during a run make exactly one more run after
 * it (whatever moved meanwhile is fetched then); a burst never queues more.
 */
export class FollowQueue {
  private running: Promise<void> | null = null;
  private again = false;
  constructor(private job: () => Promise<void>) {}

  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.job();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
  }

  /** Resolves when no run is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}
