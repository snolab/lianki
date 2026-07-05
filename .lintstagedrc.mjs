// lint-staged config (moved out of package.json so we can filter file lists).
//
// `packages/**` are workspaces we don't lint/format from the repo root — the
// pardon submodule and the standalone `lianki` CLI. `.prettierignore` lists
// `packages/`, so oxfmt aborts with "Expected at least one target file" when a
// commit touches *only* packages files. oxlint tolerates it via
// `--ignore-pattern`, but oxfmt has no equivalent — so we strip those paths
// here and skip the command entirely when nothing is left. secretlint still
// scans everything.
export default {
  "**/*": "secretlint",
  "**/*.{ts,tsx,js,jsx,mjs,cjs}": (files) => {
    const targets = files.filter((f) => !/(^|\/)packages\//.test(f));
    if (targets.length === 0) return [];
    const list = targets.map((f) => JSON.stringify(f)).join(" ");
    return [`oxlint --fix ${list}`, `oxfmt ${list}`];
  },
};
