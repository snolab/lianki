#!/usr/bin/env bun
/**
 * Builds the Learning Partner for other sites (docs/dev-debug-widget.md, "On
 * every site"): packages/debug-chat/src/embed/partner-embed.tsx with its own
 * React, minified, as ONE function expression the userscript evaluates:
 *
 *   (function (gm) { …; return { api: { mountPartner }, css: [...], rev } })
 *
 * Inside it, the names the widget reaches for are shadowed, so it never
 * touches the site it runs on:
 *
 * - `localStorage` → the userscript's own storage (GM_*), `sessionStorage` →
 *   memory: nothing is written to the site's storage, which its scripts read.
 *   Every `window.X` / `globalThis.X` / `self.X` of these names is rewritten
 *   to the bare name at build time (shadowedNames below), node_modules too.
 * - `fetch`, `EventSource`, `WebSocket`, `XMLHttpRequest` → refuse: a relative
 *   URL would go to the site (the TTS, the STT, the tree). The hub socket is
 *   opened with the real WebSocket the userscript passes to mountPartner.
 * - `navigator` → the real one without `mediaDevices` or `sendBeacon`.
 *
 *   bun scripts/build-partner-embed.ts                    # → public/partner-embed.js
 *   bun scripts/build-partner-embed.ts --out <file>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";
import { ROOT, topBlocks, widgetCss } from "./dev/debug-widget-build";

export const PARTNER_ENTRY = resolve(ROOT, "packages/debug-chat/src/embed/partner-embed.tsx");

/** The globals the prologue shadows; reached through window/globalThis/self they would escape it. */
export const SHADOWED = [
  "localStorage",
  "sessionStorage",
  "fetch",
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
  "navigator",
] as const;

/** `window.localStorage`, `globalThis.fetch`, `self.navigator`, … → the bare (shadowed) name. */
export function rewriteGlobals(src: string): string {
  const names = SHADOWED.join("|");
  return src.replace(
    new RegExp(`\\b(?:window|globalThis|self)\\s*\\.\\s*(${names})\\b`, "g"),
    (_m, name: string) => name,
  );
}

function shadowedNames(): BunPlugin {
  return {
    name: "partner-shadowed-names",
    setup(build) {
      build.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs)$/ }, (args) => {
        const src = readFileSync(args.path, "utf8");
        const ext = args.path.slice(args.path.lastIndexOf(".") + 1);
        const loader = ext === "tsx" ? "tsx" : ext === "ts" ? "ts" : ext === "jsx" ? "jsx" : "js";
        return { contents: rewriteGlobals(src), loader };
      });
    },
  };
}

/** The app's colours (light, dark), the halo and the 40px tap area, from globals.css. */
export function appCss(): string {
  const globals = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
  return topBlocks(globals)
    .filter(
      ([p, b]) =>
        /^\.(lk-halo|tap-40|lk-drain)\b/.test(p) ||
        p === "@keyframes lk-drain" ||
        ((p === ":root" || p.startsWith("@media (prefers-color-scheme")) &&
          b.includes("--background:") &&
          !b.includes("--glass")),
    )
    .map(([, b]) => b)
    .join("\n");
}

/** What runs before the bundle, inside the function: the shadowing names. */
export const PROLOGUE = `
var __nav = globalThis.navigator;
var __refuse = function (what) { return function () { throw new Error("[Lianki] partner: " + what + " is off on other sites"); }; };
var __store = function (get, set, del, keys) {
  return {
    getItem: function (k) { var v = get(String(k)); return v === undefined || v === null ? null : String(v); },
    setItem: function (k, v) { set(String(k), String(v)); },
    removeItem: function (k) { del(String(k)); },
    clear: function () { keys().forEach(del); },
    key: function (i) { return keys()[i] === undefined ? null : keys()[i]; },
    get length() { return keys().length; },
  };
};
var __mem = new Map();
var localStorage = gm && gm.get
  ? __store(gm.get, gm.set, gm.del, gm.keys)
  : __store(function (k) { return __mem.get("l:" + k); }, function (k, v) { __mem.set("l:" + k, v); }, function (k) { __mem.delete("l:" + k); }, function () { return [...__mem.keys()].filter(function (k) { return k.startsWith("l:"); }).map(function (k) { return k.slice(2); }); });
var __sess = new Map();
var sessionStorage = __store(function (k) { return __sess.get(k); }, function (k, v) { __sess.set(k, v); }, function (k) { __sess.delete(k); }, function () { return [...__sess.keys()]; });
var fetch = function () { return Promise.reject(new Error("[Lianki] partner: fetch is off on other sites")); };
var EventSource = __refuse("EventSource");
var WebSocket = __refuse("WebSocket");
var XMLHttpRequest = __refuse("XMLHttpRequest");
var navigator = new Proxy(__nav, {
  get: function (t, k) {
    if (k === "mediaDevices" || k === "sendBeacon") return undefined;
    var v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  },
  has: function (t, k) { return k !== "mediaDevices" && k !== "sendBeacon" && k in t; },
});
var process = { env: { NODE_ENV: "production" } };
var module = { exports: {} }, exports = module.exports;
`;

export type PartnerBuild = { code: string; rev: string; bytes: number; inputs: string[] };

export async function buildPartner(): Promise<PartnerBuild> {
  const out = await Bun.build({
    entrypoints: [PARTNER_ENTRY],
    target: "browser",
    format: "cjs",
    minify: true,
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [shadowedNames()],
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  const js = await out.outputs[0].text();
  const inputs = Object.keys(out.metafile?.inputs ?? {}).map((p) => resolve(process.cwd(), p));
  const css = [await widgetCss(inputs.filter((p) => /packages\/.*\.tsx?$/.test(p))), appCss()];
  const rev = Bun.hash(js + css.join(""))
    .toString(36)
    .slice(0, 8);
  const code =
    `(function (gm) {"use strict";${PROLOGUE}\n${js}\n` +
    `return { api: module.exports, css: ${JSON.stringify(css)}, rev: ${JSON.stringify(rev)} };\n})`;
  return { code, rev, bytes: code.length, inputs };
}

if (import.meta.main) {
  const i = Bun.argv.indexOf("--out");
  const file = i > -1 ? Bun.argv[i + 1] : resolve(ROOT, "public/partner-embed.js");
  const b = await buildPartner();
  writeFileSync(file, b.code);
  console.log(`partner-embed ${b.rev}: ${(b.bytes / 1024) | 0} KB → ${file}`);
}
