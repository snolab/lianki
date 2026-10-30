// lint-staged config (moved out of package.json so we can filter file lists).
//
// Secrets only. oxlint and oxfmt used to run here with --fix/write, which
// rewrote staged files silently and only ever saw the staged ones. They now run
// check-only over the whole repo (`bun run lint`, ~0.1 s) in both hooks and in
// CI, and fail the commit instead of editing it — `bun fix` repairs.
export default {
  "**/*": "secretlint",
};
