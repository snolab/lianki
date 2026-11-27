#!/usr/bin/env bun
/**
 * Workers static assets are refused above 25 MiB each ("Asset too large"), and
 * wrangler only says so at `wrangler deploy`, after the D1 migrations already
 * ran. This fails earlier, listing every file over the limit:
 *
 *   bun scripts/ci/check-asset-size.ts                     # .open-next/assets
 *   bun scripts/ci/check-asset-size.ts <dir> [maxMiB]
 *
 * Runs in deploy-worker.yml right after the OpenNext build. Background: PR
 * #1155 bundled onnxruntime-web's 25.6 MiB jsep wasm and every prod deploy
 * failed until it moved to a CDN (packages/debug-chat/src/webgpu-stt.ts).
 */
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

export const WORKERS_ASSET_MAX_BYTES = 25 * 1024 * 1024;

export function oversizedAssets(
  dir: string,
  maxBytes = WORKERS_ASSET_MAX_BYTES,
): { file: string; bytes: number }[] {
  const out: { file: string; bytes: number }[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const bytes = statSync(p).size;
        if (bytes > maxBytes) out.push({ file: relative(dir, p), bytes });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.bytes - a.bytes);
}

if (import.meta.main) {
  const dir = process.argv[2] ?? ".open-next/assets";
  const maxMiB = Number(process.argv[3] ?? 25);
  const maxBytes = maxMiB * 1024 * 1024;
  let bad: { file: string; bytes: number }[];
  try {
    bad = oversizedAssets(dir, maxBytes);
  } catch (e) {
    console.error(`check-asset-size: cannot read ${dir}: ${(e as Error).message}`);
    process.exit(2);
  }
  const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  for (const f of bad) console.error(`✗ ${dir}/${f.file}: ${mib(f.bytes)} > ${maxMiB} MiB`);
  if (bad.length) {
    console.error(
      `check-asset-size: ${bad.length} asset(s) over the Workers per-file limit; load them from a CDN or split them`,
    );
    process.exit(1);
  }
  console.log(`✓ ${dir}: every asset is at most ${maxMiB} MiB`);
}
