#!/usr/bin/env bun
/**
 * What the userscript costs a plain page with 随身Li closed: its size, and the
 * time to compile and run it (muted headless Chromium, median of N runs), so
 * the bundled chat window's cost is measured, not guessed.
 *
 *   bun scripts/qa/userscript-load-cost.ts public/lianki.user.js [other.user.js …] [--runs 15]
 *
 * The script runs with minimal GM stubs on a plain page (not lianki.com, no
 * consent stored, chat closed): exactly the path every page pays.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const args = Bun.argv.slice(2);
const runsAt = args.indexOf("--runs");
const RUNS = runsAt > -1 ? Number(args[runsAt + 1]) : 15;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--runs");

const STUBS = `
var GM_values = new Map();
var GM_getValue = (k, d) => (GM_values.has(k) ? GM_values.get(k) : d);
var GM_setValue = (k, v) => void GM_values.set(k, v);
var GM_deleteValue = (k) => void GM_values.delete(k);
var GM_listValues = () => [...GM_values.keys()];
var GM_addValueChangeListener = () => 0;
var GM_removeValueChangeListener = () => {};
var GM_registerMenuCommand = () => 0;
var GM_xmlhttpRequest = (d) => { setTimeout(() => d.onerror && d.onerror(), 0); return { abort() {} }; };
var GM_info = { script: { version: "0", downloadURL: "https://lianki.com/lianki.user.js" }, sandboxMode: "raw" };
var unsafeWindow = window;
`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response("<!doctype html><meta charset=utf-8><title>plain</title><p>A plain page.</p>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
const browser = await launchSilent(chromium);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
try {
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const compile: number[] = [];
    const run: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const ctx = await newSilentContext(browser, { viewport: { width: 390, height: 780 } });
      const p = await ctx.newPage();
      await p.goto(`http://127.0.0.1:${server.port}/`);
      const t = await p.evaluate(
        ({ src, stubs }) => {
          const t0 = performance.now();
          const fn = new Function(stubs + "\n" + src);
          const t1 = performance.now();
          fn();
          const t2 = performance.now();
          return { compile: t1 - t0, run: t2 - t1 };
        },
        { src: code, stubs: STUBS },
      );
      compile.push(t.compile);
      run.push(t.run);
      await ctx.close();
    }
    console.log(
      JSON.stringify({
        file,
        bytes: code.length,
        compileMs: Number(median(compile).toFixed(1)),
        runMs: Number(median(run).toFixed(1)),
        runs: RUNS,
      }),
    );
  }
} finally {
  await browser.close();
  server.stop(true);
}
