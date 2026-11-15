/**
 * The daily release (docs/shipping.md, "Daily release"): pure parts.
 * scripts/release/daily-pr.ts talks to git and GitHub; everything it decides
 * or writes comes from here, tested in unit/daily-release.test.ts.
 *
 * One release a day: `main` → `prod` as one PR, "Release YYYY-MM-DD" (UTC).
 * A hot fix is a PR straight to `prod`; before the next release, prod's
 * changes go back to main as a "Back-merge prod YYYY-MM-DD" PR.
 */

export const CLAUDE_LINE = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
export const REQUIRED_CHECK = "Typecheck + unit";
export const RELEASE_LABEL = "release";
export const MAX_LISTED = 200;

export type Commit = { sha: string; subject: string };
export type Group = { heading: string; items: string[] };

/** YYYY-MM-DD of `now` in UTC. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export const releaseTitle = (date: string) => `Release ${date}`;
export const backMergeTitle = (date: string) => `Back-merge prod ${date}`;

/** The date in a release or back-merge title, or null. */
export function titleDate(title: string): string | null {
  return /^(?:Release|Back-merge prod) (\d{4}-\d{2}-\d{2})$/.exec(title)?.[1] ?? null;
}

// Conventional-commit type → heading; anything else is "Other".
const HEADINGS: [string[], string][] = [
  [["feat"], "New"],
  [["fix"], "Fixes"],
  [["perf"], "Faster"],
  [["refactor", "style"], "Refactors"],
  [["docs"], "Docs"],
  [["test"], "Tests"],
  [["build", "ci", "chore", "deps"], "Maintenance"],
  [["revert"], "Reverts"],
];
const ORDER = [...HEADINGS.map(([, h]) => h), "Other"];

/** `feat(voice)!: x` → { heading: "New", text: "voice: x" }. */
export function parseSubject(subject: string): { heading: string; text: string } {
  const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject.trim());
  const type = m?.[1].toLowerCase();
  const heading = HEADINGS.find(([types]) => type && types.includes(type))?.[1];
  if (!m || !heading) return { heading: "Other", text: subject.trim() };
  return { heading, text: m[2] ? `${m[2]}: ${m[3]}` : m[3] };
}

/**
 * GitHub closes an issue on "fixes #12" in a PR body. A release must not close
 * anything (an issue closes when its fix is released, by hand, with the
 * version), so a closing keyword followed by a reference gets parentheses.
 */
export function neutralizeClosers(text: string): string {
  return text.replace(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?)\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi,
    "$1$2 ($3)",
  );
}

/** Commits by heading, in a fixed order; back-merges of prod left out. */
export function groupCommits(commits: Commit[]): Group[] {
  const by = new Map<string, string[]>();
  for (const c of commits) {
    if (/^Back-merge prod\b/.test(c.subject)) continue;
    const { heading, text } = parseSubject(c.subject);
    by.set(heading, [
      ...(by.get(heading) ?? []),
      `${neutralizeClosers(text)} (${c.sha.slice(0, 7)})`,
    ]);
  }
  return ORDER.filter((h) => by.has(h)).map((heading) => ({ heading, items: by.get(heading)! }));
}

function listed(groups: Group[], max: number): string[] {
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const g of groups) {
    total += g.items.length;
    const items = g.items.slice(0, Math.max(0, max - shown));
    shown += items.length;
    if (items.length) lines.push(`### ${g.heading}`, "", ...items.map((i) => `- ${i}`), "");
  }
  if (total > shown) lines.push(`…and ${total - shown} more (see the commits tab).`, "");
  return lines;
}

/** The release PR's body: first person, commit subjects grouped. */
export function releaseBody(o: {
  date: string;
  base: string;
  head: string;
  commits: Commit[];
  max?: number;
}): string {
  const n = o.commits.length;
  return [
    `Today's release: ${n} change${n === 1 ? "" : "s"} from \`${o.head}\` since the last release to \`${o.base}\`. Merging this deploys lianki.com.`,
    "",
    ...listed(groupCommits(o.commits), o.max ?? MAX_LISTED),
    `Opened by the daily release (docs/shipping.md, "Daily release"); it merges itself once \`${REQUIRED_CHECK}\` is green on \`${o.head}\`.`,
    "",
    CLAUDE_LINE,
  ].join("\n");
}

/** The back-merge PR's body: prod's own commits (hot fixes) going back to main. */
export function backMergeBody(o: {
  date: string;
  base: string;
  head: string;
  commits: Commit[];
}): string {
  return [
    `Hot fixes that went straight to \`${o.head}\` and are not on \`${o.base}\` yet. They go back first, so the next release cannot drop them.`,
    "",
    ...listed(groupCommits(o.commits), MAX_LISTED),
    `The release to \`${o.head}\` waits until this has merged (next scheduled run, or run the Daily release workflow by hand).`,
    "",
    CLAUDE_LINE,
  ].join("\n");
}

/** What to do this run. */
export type Plan =
  | { kind: "nothing"; reason: string }
  | { kind: "back-merge" }
  | { kind: "release" };

/**
 * prodHasOwn: merging prod into main would change main's tree (hot fixes not
 * back yet, or a conflict). mainAhead: main has commits prod lacks.
 */
export function plan(o: { prodExists: boolean; prodHasOwn: boolean; mainAhead: boolean }): Plan {
  if (!o.prodExists) return { kind: "nothing", reason: "no prod branch" };
  if (o.prodHasOwn) return { kind: "back-merge" };
  if (!o.mainAhead) return { kind: "nothing", reason: "prod already has everything on main" };
  return { kind: "release" };
}

export type OpenPr = { number: number; title: string; url: string };

/** Open a new PR, or update the open one; a PR from an earlier day gets a comment saying so. */
export function prAction(
  open: OpenPr | undefined,
  today: string,
): { kind: "create" } | { kind: "update"; stale: boolean; since: string | null } {
  if (!open) return { kind: "create" };
  const since = titleDate(open.title);
  return { kind: "update", stale: since !== today, since };
}

export function staleComment(since: string | null, today: string, kind: "release" | "back-merge") {
  const what = kind === "release" ? "release" : "back-merge";
  return `This ${what} from ${since ?? "an earlier run"} did not merge, so I updated it for ${today} instead of opening another one.`;
}

export type CheckRun = { name: string; status: string; conclusion: string | null; id?: number };

/** The newest run of the required check on a commit: success, pending, failure or missing. */
export function checkState(runs: CheckRun[], name = REQUIRED_CHECK) {
  const mine = runs.filter((r) => r.name === name).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  const r = mine[0];
  if (!r) return "missing" as const;
  if (r.status !== "completed") return "pending" as const;
  return r.conclusion === "success" ? ("success" as const) : ("failure" as const);
}

/** GitHub says the checks are still expected/pending: wait and try again. */
export const retryable = (err: string) => /expected|pending|not yet|try again/i.test(err);

/** The base branch merges through a merge queue: enqueue, not merge. */
export const needsQueue = (err: string) => /merge queue/i.test(err);

export type Args = {
  dryRun: boolean;
  base: string;
  head: string;
  repo: string;
  waitMin: number;
};

export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  const val = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const wait = Number(val("wait-min") ?? env.LIANKI_RELEASE_WAIT_MIN ?? 45);
  return {
    dryRun: argv.includes("--dry-run") || env.DRY_RUN === "true",
    base: val("base") || env.LIANKI_RELEASE_BRANCH || "prod",
    head: val("head") || "main",
    repo: val("repo") || env.GITHUB_REPOSITORY || "snolab/lianki",
    waitMin: Number.isFinite(wait) && wait >= 0 ? wait : 45,
  };
}
