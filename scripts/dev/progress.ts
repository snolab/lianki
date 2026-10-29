#!/usr/bin/env bun
/**
 * Report an agent's progress to the owner's live /dev/roadmap
 * (docs/agent-progress.md). One POST to lianki-push, then exit.
 *
 *   bun scripts/dev/progress.ts --agent liveroad --task "Live roadmap" --status doing --pct 40
 *   bun scripts/dev/progress.ts --agent liveroad --task "Live roadmap" --done --pr 300
 *
 * The site is LIANKI_URL (default: the production site, as for eval.ts).
 * The token is PROGRESS_TOKEN from the environment, else from .dev.vars in
 * this checkout or the main one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BASE } from "./eval-socket";
import { PROGRESS_USAGE, parseProgressArgs } from "./progress-args";

function tokenFromDevVars(): string | undefined {
  const roots = [join(import.meta.dir, "..", "..")];
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dir,
  });
  if (git.success) roots.push(dirname(git.stdout.toString().trim()));
  for (const root of roots) {
    try {
      const m = /^PROGRESS_TOKEN=["']?([^"'\n]+)["']?\s*$/m.exec(
        readFileSync(join(root, ".dev.vars"), "utf8"),
      );
      if (m) return m[1].trim();
    } catch {}
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(PROGRESS_USAGE);
  process.exit(0);
}
const report = parseProgressArgs(args);
if (report instanceof Error) {
  console.error(`progress: ${report.message}\n${PROGRESS_USAGE}`);
  process.exit(2);
}
const token = process.env.PROGRESS_TOKEN || tokenFromDevVars();
if (!token) {
  console.error("progress: no PROGRESS_TOKEN (set it in the environment or .dev.vars)");
  process.exit(2);
}
const res = await fetch(`${BASE}/api/version/progress`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(report),
  signal: AbortSignal.timeout(10_000),
}).catch((e: unknown) => e as Error);
if (res instanceof Error) {
  console.error(`progress: ${res.message}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`progress: ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const { readers } = (await res.json()) as { readers?: number };
console.log(`progress: ${report.id} ${report.status}${readers ? ` (${readers} watching)` : ""}`);
