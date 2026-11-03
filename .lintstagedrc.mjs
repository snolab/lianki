// lint-staged config: the pre-commit hook's per-file checks, on staged files only.
//
// - secretlint on every staged file.
// - oxlint --fix, then oxfmt (write), on staged JS/TS outside packages/ — the
//   same scope as `bun run lint`. lint-staged re-stages what they rewrite and,
//   on a partially staged file, hides the unstaged hunks while they run, so
//   only the staged content is fixed and committed. oxlint still fails the
//   commit on an error it cannot fix.
//
// The whole-repo check (`bun run lint`), typecheck and the unit suite with its
// coverage gate run in pre-push and in CI, not per commit (owner, 2026-11-03:
// per-commit typecheck + unit made a commit take minutes).

const LINTED = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/** Repo-relative, forward slashes — lint-staged hands over absolute paths. */
export const toRel = (file, cwd = process.cwd()) => {
  const f = file.replaceAll("\\", "/");
  const root = cwd.replaceAll("\\", "/").replace(/\/?$/, "/");
  return f.startsWith(root) ? f.slice(root.length) : f;
};

/** Staged files `bun run lint` covers: JS/TS, not under packages/. */
export const lintable = (files, cwd = process.cwd()) =>
  files.filter((f) => LINTED.test(f) && !toRel(f, cwd).startsWith("packages/"));

/** Commands for the staged JS/TS files; none when every one is under packages/. */
export const lintCommands = (files, cwd = process.cwd()) => {
  const mine = lintable(files, cwd);
  if (mine.length === 0) return [];
  const args = mine.map((f) => JSON.stringify(f)).join(" ");
  return [`oxlint --fix ${args}`, `oxfmt --no-error-on-unmatched-pattern ${args}`];
};

export default {
  "**/*": "secretlint",
  "*.{ts,tsx,js,jsx,mjs,cjs}": (files) => lintCommands(files),
};
