#!/usr/bin/env node
/**
 * The Learning Partner chat (packages/debug-chat) over a long session, on the
 * local /harness page with the hot widget: does anything it holds grow?
 *
 *   node scripts/dev/debug-chat-soak.mjs            # 10 minutes
 *   SOAK_MIN=3 node scripts/dev/debug-chat-soak.mjs
 *
 * iPhone-sized, muted Chromium. The harness keeps the last 200 lines
 * (`?cap=200`, as the app's trimHistory does), and an agent line arrives every
 * 2 s. Every ~20 s it minimizes and expands, opens and closes the tree, drags
 * the bar, focuses the input (a visualViewport resize, as the keyboard does),
 * and turns the mic on and off on a fake media stream (Chromium's fake device:
 * a tone that never reaches a speaker; the STT requests fail, which is fine).
 *
 * Each minute, after a forced GC: CDP heap, Nodes, JSEventListeners, the DOM
 * count, live AudioContext / MediaStream / WebSocket / EventSource / observer
 * objects, and pending timers and frames (instrumented).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium, devices } from "playwright";

const MINUTES = Number(process.env.SOAK_MIN || 10);
const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const ORIGIN = `http://localhost:${port}`;
const server = spawn(
  "bun",
  ["scripts/dev/debug-widget-server.ts", "--port", String(port), "--no-tunnel"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("widget server did not start in 60 s")), 60_000);
  server.stdout.on("data", (b) => {
    if (String(b).includes("listening")) {
      clearTimeout(t);
      resolve();
    }
  });
  server.on("exit", (c) => reject(new Error(`widget server exited (${c})`)));
});

const browser = await chromium.launch({
  args: [
    "--mute-audio",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({ ...devices["iPhone 13"], permissions: ["microphone"] });
await ctx.addInitScript((src) => {
  localStorage.setItem("lk:debug-widget-src", src);
  const live = { timeouts: new Set(), intervals: new Set(), rafs: new Set() };
  window.__soak = live;
  const st = window.setTimeout.bind(window);
  const ct = window.clearTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => {
    const id = st(
      (...x) => {
        live.timeouts.delete(id);
        if (typeof fn === "function") fn(...x);
      },
      ms,
      ...a,
    );
    live.timeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => {
    live.timeouts.delete(id);
    ct(id);
  };
  const si = window.setInterval.bind(window);
  const ci = window.clearInterval.bind(window);
  window.setInterval = (...a) => {
    const id = si(...a);
    live.intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    live.intervals.delete(id);
    ci(id);
  };
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => {
    const id = raf((t) => {
      live.rafs.delete(id);
      fn(t);
    });
    live.rafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    live.rafs.delete(id);
    caf(id);
  };
}, `${ORIGIN}/debug-chat.js`);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${ORIGIN}/harness?cap=200`);
await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");

async function countOf(ctor) {
  const proto = await cdp.send("Runtime.evaluate", { expression: `${ctor}.prototype` });
  if (!proto.result.objectId) return null;
  const { objects } = await cdp.send("Runtime.queryObjects", {
    prototypeObjectId: proto.result.objectId,
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: objects.objectId,
    functionDeclaration: "function(){return this.length}",
    returnByValue: true,
  });
  await cdp.send("Runtime.releaseObject", { objectId: objects.objectId });
  return result.value;
}
async function snapshot(min) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const live = {};
  for (const c of [
    "AudioContext",
    "MediaStream",
    "HTMLAudioElement",
    "WebSocket",
    "EventSource",
    "ResizeObserver",
    "IntersectionObserver",
    "MutationObserver",
  ])
    live[c] = await countOf(c).catch(() => null);
  const p = await page.evaluate(() => ({
    dom: document.getElementsByTagName("*").length,
    lines: document.querySelectorAll("[data-debug-chat] li, [data-testid='debug-chat-float']")
      .length,
    timeouts: window.__soak.timeouts.size,
    intervals: window.__soak.intervals.size,
    rafs: window.__soak.rafs.size,
  }));
  return {
    min,
    heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1),
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    ...p,
    actx: live.AudioContext,
    streams: live.MediaStream,
    audioEl: live.HTMLAudioElement,
    ws: live.WebSocket,
    es: live.EventSource,
    ro: live.ResizeObserver,
    io: live.IntersectionObserver,
    mo: live.MutationObserver,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (id) =>
  page
    .click(`[data-testid="${id}"]`, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
let n = 0;
const pusher = setInterval(() => {
  n++;
  void page
    .evaluate((n) => globalThis.__push?.(`line ${n}: ${"word ".repeat(n % 12)}`), n)
    .catch(() => {});
}, 2000);

const rows = [await snapshot(0)];
console.error(JSON.stringify(rows[0]));
const t0 = Date.now();
for (let minute = 1; minute <= MINUTES; minute++) {
  while (Date.now() - t0 < minute * 60_000) {
    await click("debug-chat-pill-min"); // minimize
    await sleep(1500);
    await click("debug-chat-pill-min"); // expand
    await sleep(800);
    if (await click("debug-chat-tree-button")) {
      await sleep(1200);
      await page.keyboard.press("Escape");
    }
    await page.focus('[data-testid="debug-chat-input"]').catch(() => {});
    await page.setViewportSize({ width: 390, height: 500 }); // the keyboard opens
    await sleep(600);
    await page.setViewportSize({ width: 390, height: 664 });
    await page
      .locator('[data-testid="debug-chat-input"]')
      .blur()
      .catch(() => {});
    const pill = await page
      .locator('[data-testid="debug-chat-pill"]')
      .boundingBox()
      .catch(() => null);
    if (pill) {
      await page.mouse.move(pill.x + 10, pill.y + pill.height / 2);
      await page.mouse.down();
      await page.mouse.move(pill.x + 60, pill.y + pill.height / 2, { steps: 6 });
      await page.mouse.up();
    }
    if (await click("debug-chat-mic")) {
      await sleep(4000); // listening on the fake stream
      await click("debug-chat-mic");
    }
    await sleep(2000);
  }
  const r = await snapshot(minute);
  rows.push(r);
  console.error(JSON.stringify(r));
}
clearInterval(pusher);
const cols = Object.keys(rows[0]);
console.log(cols.join("\t"));
for (const r of rows) console.log(cols.map((c) => r[c]).join("\t"));
if (errs.length) console.log(`page errors: ${[...new Set(errs)].slice(0, 5).join(" | ")}`);
await browser.close();
server.kill("SIGTERM");
