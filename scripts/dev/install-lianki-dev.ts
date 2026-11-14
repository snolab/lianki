#!/usr/bin/env bun
/**
 * Put `lianki-dev` on PATH for every local agent (docs/lianki-dev-cli.md,
 * "Install"): a two-line shim that runs this checkout's
 * scripts/dev/lianki-dev.ts with bun. No copy of the code, so a `git pull`
 * is picked up at once; run from a worktree it still uses the worktree of
 * the current directory (lianki-dev.ts resolves `--repo` itself).
 *
 *   bun scripts/dev/install-lianki-dev.ts            # → ~/.bun/bin/lianki-dev (else ~/.local/bin)
 *   bun scripts/dev/install-lianki-dev.ts --dir DIR  # another directory on PATH
 *   bun scripts/dev/install-lianki-dev.ts --print    # only show the shim
 *
 * Prints where it went and, when that directory is not on PATH, the line to add.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};
const repo = resolve(dirname(import.meta.path), "..", "..");
const script = join(repo, "scripts", "dev", "lianki-dev.ts");

/** The shim: bun first on PATH, else ~/.bun/bin/bun. */
export const shim = (target: string) =>
  `#!/bin/sh
# lianki-dev: the Lianki agent lanes' CLI (docs/lianki-dev-cli.md). Installed by scripts/dev/install-lianki-dev.ts.
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
exec "$BUN" ${JSON.stringify(target)} "$@"
`;

if (args.includes("--print")) {
  process.stdout.write(shim(script));
  process.exit(0);
}
const dir =
  flag("--dir") ??
  (existsSync(join(homedir(), ".bun", "bin"))
    ? join(homedir(), ".bun", "bin")
    : join(homedir(), ".local", "bin"));
mkdirSync(dir, { recursive: true });
const path = join(dir, "lianki-dev");
writeFileSync(path, shim(script));
chmodSync(path, 0o755);
console.log(`installed ${path} → ${script}`);
const onPath = (process.env.PATH ?? "").split(":").includes(dir);
if (!onPath) console.log(`add it to PATH:  export PATH="${dir}:$PATH"`);
console.log(`try:  lianki-dev doctor`);
