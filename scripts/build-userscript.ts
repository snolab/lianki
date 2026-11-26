#!/usr/bin/env bun
/**
 * The release build of the userscript: src/lianki.user.ts → public/lianki.user.js,
 * as `userbuild` did (its ==UserScript== header as the banner, iife, readable),
 * plus 随身Li's chat window bundled in (scripts/portable-window-plugin.ts).
 *
 *   bun scripts/build-userscript.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { partnerBuildCached, portableWindowPlugin } from "./portable-window-plugin";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "src/lianki.user.ts");
const banner =
  readFileSync(ENTRY, "utf8").match(/(\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n?)/)?.[1] ??
  "";
if (!banner) throw new Error("no userscript meta found in src/lianki.user.ts");

const t0 = performance.now();
const partner = await partnerBuildCached();
const out = await Bun.build({
  entrypoints: [ENTRY],
  banner,
  format: "iife",
  outdir: resolve(ROOT, "public"),
  plugins: [portableWindowPlugin(partner)],
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
const bytes = out.outputs[0] ? (await out.outputs[0].text()).length : 0;
console.log(`lianki.user.js: ${(bytes / 1024) | 0} KB (${Math.round(performance.now() - t0)} ms)`);
