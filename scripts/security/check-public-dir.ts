#!/usr/bin/env bun
/**
 * Public-directory hygiene (docs/security-measures.md, 脆弱性対策 ②): nothing
 * that is served as a static file may be a secret, an env file, a key, a
 * database, a backup, or a source map of server code.
 *
 *   bun scripts/security/check-public-dir.ts                 # public/
 *   bun scripts/security/check-public-dir.ts .open-next/assets  # the built static assets too
 *
 * Exits 1 listing every offending file. Runs in CI (ci.yml, unit job) on
 * `public/`, and in the deploy workflow on the OpenNext asset directory after
 * the build — the exact set of files the Worker serves.
 */
import { existsSync } from "fs";
import { checkDir } from "@/lib/security/public-dir";

{
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["public"];
  let bad = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      console.error(`check-public-dir: ${dir} does not exist`);
      process.exit(2);
    }
    const findings = checkDir(dir);
    for (const f of findings) console.error(`✗ ${dir}/${f.file}: ${f.reason}`);
    bad += findings.length;
    if (!findings.length)
      console.log(`✓ ${dir}: no secrets, env files, keys or server source maps`);
  }
  process.exit(bad ? 1 : 0);
}
