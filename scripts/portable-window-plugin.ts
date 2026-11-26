/**
 * Puts 随身Li's chat window (the main site's DebugChat, as the Learning
 * Partner build) into the userscript: src/portable-window.ts is replaced with
 * that build as ONE plain function, `export default function (gm) {…}`. Its
 * body (React, the widget, the CSS) is parsed with the script but runs only
 * when the chat calls it, so a page where chat stays closed executes none of
 * it. No eval, no remote code: the manager injects it with the rest.
 *
 * The partner build runs BEFORE the userscript's Bun.build (a Bun.build
 * inside a plugin of another one hangs), so the plugin takes it ready-made:
 *
 *   plugins: [portableWindowPlugin(await partnerBuildCached())]
 */
import { statSync } from "node:fs";
import type { BunPlugin } from "bun";
import { buildPartner, type PartnerBuild } from "./build-partner-embed";

let last: { build: PartnerBuild; stamp: string } | null = null;

const stampOf = (inputs: string[]) =>
  inputs
    .map((p) => {
      try {
        return `${p}:${statSync(p).mtimeMs}`;
      } catch {
        return `${p}:-`;
      }
    })
    .join("|");

/** The partner build, reused in this process while none of its inputs changed. */
export async function partnerBuildCached(): Promise<PartnerBuild> {
  if (last && stampOf(last.build.inputs) === last.stamp) return last.build;
  const build = await buildPartner();
  last = { build, stamp: stampOf(build.inputs) };
  return build;
}

/** `(function (gm) {…})` → `export default function portableWindow(gm) {…}`. */
export function windowModule(code: string): string {
  const fn = code
    .trim()
    .replace(/^\(/, "")
    .replace(/\)\s*;?\s*$/, "");
  if (!fn.startsWith("function")) throw new Error("partner build is not one function expression");
  return `export default ${fn.replace(/^function\s*\(/, "function portableWindow(")}\n`;
}

export function portableWindowPlugin(build: PartnerBuild): BunPlugin {
  const contents = windowModule(build.code);
  return {
    name: "lianki-portable-window",
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/]portable-window\.ts$/ }, () => ({ contents, loader: "js" }));
    },
  };
}
