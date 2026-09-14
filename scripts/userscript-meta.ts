import { readFileSync } from "fs";

/**
 * The ==UserScript== metadata block, read out of the TS source.
 *
 * The header stays authored in src/lianki.user.ts — it is the single source of
 * truth that the release build, public/lianki.meta.js, and the Tampermonkey
 * auto-update flow all derive from. Every dev target parses it from there rather
 * than re-declaring it, because a dev script whose @match or @grant disagreed
 * with the released one would reproduce bugs that don't exist (or mask ones
 * that do).
 */

/** Keys that may legally repeat, so one occurrence still yields an array. */
const MULTI = new Set(["match", "include", "exclude", "grant", "connect", "require", "resource"]);

export type UserscriptMeta = Record<string, string | string[]>;

export function parseUserscriptMeta(file: string): UserscriptMeta {
  const src = readFileSync(file, "utf8");
  const block = src.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)?.[1];
  if (!block) throw new Error(`No ==UserScript== metadata block found in ${file}`);

  const meta: UserscriptMeta = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*\/\/\s*@(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    if (MULTI.has(key)) ((meta[key] ??= []) as string[]).push(value);
    else meta[key] = value;
  }
  return meta;
}

/**
 * Strip the auto-update URLs. A dev build that kept them would let Tampermonkey
 * quietly replace the script under test with production on its next update check.
 */
export function withoutAutoUpdate(meta: UserscriptMeta): UserscriptMeta {
  const { downloadURL: _d, updateURL: _u, ...rest } = meta;
  return rest;
}

export function formatMetaBlock(meta: UserscriptMeta): string {
  const pad = Math.max(...Object.keys(meta).map((k) => k.length)) + 1;
  const lines = Object.entries(meta).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).map((v) => `// @${key.padEnd(pad)}${v}`.trimEnd()),
  );
  return ["// ==UserScript==", ...lines, "// ==/UserScript=="].join("\n");
}
