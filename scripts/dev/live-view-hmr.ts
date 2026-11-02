#!/usr/bin/env bun
/**
 * Live view's hot reload, timed (docs/live-view.md, "HMR"): from a save to
 * the change on screen.
 *
 *   bun scripts/dev/live-view-hmr.ts [--runs 5] [--tailnet]
 *
 * Widget: runs scripts/dev/debug-widget-server.ts (on localhost, or with
 * --tailnet also through `tailscale serve` at a throwaway path, removed on
 * exit), opens its /harness in a silent Chromium with the widget loaded from
 * there, then saves a one-line change to the widget's entry and times it until
 * the page has re-imported and re-rendered the widget (a MutationObserver on
 * the page stamps the moment). The entry file is restored afterwards.
 *
 * Islands: runs scripts/dev/islands-server.ts on a throwaway entry and times a
 * save until its `slot-reload` event, with and without the typecheck (the page's
 * import and swap after that is the same as the widget's).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";
import { ROOT } from "./debug-widget-build";

const argv = process.argv.slice(2);
const RUNS = Number(argv[argv.indexOf("--runs") + 1]) || 5;
const TAILNET = argv.includes("--tailnet");

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => done(typeof a === "object" && a ? a.port : 0));
    });
  });

function start(args: string[], ready: RegExp): Promise<{ p: ChildProcess; out: () => string }> {
  const p = spawn("bun", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  return new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error(`${args[0]} did not start:\n${out}`)), 60_000);
    const on = (b: Buffer) => {
      out += String(b);
      if (ready.test(out)) {
        clearTimeout(t);
        done({ p, out: () => out });
      }
    };
    p.stdout?.on("data", on);
    p.stderr?.on("data", on);
    p.on("exit", (c) => fail(new Error(`${args[0]} exited ${c}:\n${out}`)));
  });
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `median ${s[Math.floor(s.length / 2)]} ms, min ${s[0]}, max ${s[s.length - 1]} (n=${s.length})`;
};

async function widget(): Promise<string> {
  const port = await freePort();
  const tailPath = `/lianki-widget-hmr-${process.pid}`;
  const { p, out } = await start(
    [
      "scripts/dev/debug-widget-server.ts",
      "--port",
      String(port),
      ...(TAILNET ? ["--tailnet", tailPath] : ["--no-tunnel"]),
    ],
    /listening/,
  );
  const origin = TAILNET
    ? (out().match(/https:\/\/[^\s"]+?\/lianki-widget-hmr-\d+/)?.[0] ?? "")
    : `http://localhost:${port}`;
  if (!origin) throw new Error(`no tailnet origin in:\n${out()}`);
  const entry = join(ROOT, "packages/debug-chat/src/debug-chat-widget.ts");
  const original = readFileSync(entry, "utf8");
  const browser = await launchSilent(chromium);
  const times: number[] = [];
  try {
    const ctx = await newSilentContext(browser, { viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(
      (src) => localStorage.setItem("lk:debug-widget-src", src),
      `${origin}/debug-chat.js`,
    );
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/harness?min`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    for (let k = 1; k <= RUNS; k++) {
      const before = await page.getAttribute("[data-debug-widget]", "data-debug-widget");
      // Stamp the first re-render with a new rev, in the page's own clock.
      await page.evaluate((rev) => {
        const w = window as unknown as { __hmrAt?: number };
        w.__hmrAt = undefined;
        const mo = new MutationObserver(() => {
          const v = document
            .querySelector("[data-debug-widget]")
            ?.getAttribute("data-debug-widget");
          if (v && v !== rev && v !== "remote") {
            w.__hmrAt = performance.timeOrigin + performance.now();
            mo.disconnect();
          }
        });
        mo.observe(document.body, { subtree: true, attributes: true, childList: true });
      }, before);
      const t0 = Date.now();
      writeFileSync(entry, `${original}\nexport const __hmrProbe = ${k};\n`);
      await page.waitForFunction(() => (window as unknown as { __hmrAt?: number }).__hmrAt, null, {
        timeout: 30_000,
      });
      const at = await page.evaluate(() => (window as unknown as { __hmrAt: number }).__hmrAt);
      times.push(Math.round(at - t0));
    }
    await ctx.close();
  } finally {
    writeFileSync(entry, original);
    await browser.close();
    p.kill("SIGINT");
  }
  return `widget (${TAILNET ? "tailnet" : "localhost"}), save → re-rendered on the page: ${stats(times)}`;
}

async function islands(typecheck: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lk-islands-hmr-"));
  const entry = join(dir, "entry.jsx");
  const src = (tag: number) => `
export const ISLANDS_API = 1;
export const versions = { "header.brand": 2 };
function RemoteBrand({ appName }) { return <b data-v="${tag}">{appName} ${tag}</b>; }
export const islands = { "header.brand": RemoteBrand };
`;
  writeFileSync(entry, src(0));
  const port = await freePort();
  const { p } = await start(
    [
      "scripts/dev/islands-server.ts",
      "--port",
      String(port),
      "--entry",
      entry,
      ...(typecheck ? [] : ["--no-typecheck"]),
    ],
    /listening on/,
  );
  const times: number[] = [];
  const ac = new AbortController();
  try {
    const r = await fetch(`http://localhost:${port}/events`, { signal: ac.signal });
    const reader = r.body!.getReader();
    let buf = "";
    const next = async (event: string) => {
      for (;;) {
        const i = buf.indexOf(`event: ${event}\n`);
        if (i >= 0) {
          buf = buf.slice(buf.indexOf("\n\n", i) + 2);
          return;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += new TextDecoder().decode(value);
      }
    };
    await next("hello");
    for (let k = 1; k <= RUNS; k++) {
      const t0 = Date.now();
      writeFileSync(entry, src(k));
      await next("slot-reload");
      times.push(Date.now() - t0);
    }
  } finally {
    ac.abort();
    p.kill("SIGINT");
    rmSync(dir, { recursive: true, force: true });
  }
  return `islands (${typecheck ? "with" : "without"} typecheck), save → slot-reload sent: ${stats(times)}`;
}

console.log(await widget());
console.log(await islands(false));
console.log(await islands(true));
process.exit(0);
