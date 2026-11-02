#!/usr/bin/env bun
/**
 * worker.ts must keep the OpenNext build's contract unchanged: every export
 * of .open-next/worker.js (its Durable Object classes and the default
 * handler) plus DebugSessions, nothing lost. Run after `opennextjs-cloudflare
 * build` (deploy-worker.yml, before any deploy):
 *
 *   bun scripts/ci/check-worker-exports.ts [.open-next/worker.js]
 *
 * It bundles worker.ts the way the deploy does (`wrangler deploy --dry-run
 * --outdir`) and compares the bundle's export list with the artifact's.
 * Exit 1 on any difference. The comparison (./worker-exports.ts) is
 * unit-tested in unit/check-worker-exports.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareExports, exportNames } from "./worker-exports";

const artifactPath = process.argv[2] ?? ".open-next/worker.js";
const artifact = exportNames(readFileSync(artifactPath, "utf8"));
const out = mkdtempSync(join(tmpdir(), "lianki-worker-bundle-"));
try {
  const p = Bun.spawnSync(["bunx", "wrangler", "deploy", "--dry-run", "--outdir", out], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!p.success) throw new Error("wrangler deploy --dry-run failed");
  const bundle = exportNames(readFileSync(join(out, "worker.js"), "utf8"));
  const { missing, extra } = compareExports(artifact, bundle);
  console.log(
    JSON.stringify({ artifact: [...artifact].sort(), bundle: [...bundle].sort(), missing, extra }),
  );
  if (missing.length || extra.length) {
    console.error("worker.ts does not keep the OpenNext build's exports unchanged");
    process.exitCode = 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
