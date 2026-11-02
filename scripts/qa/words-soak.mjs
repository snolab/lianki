// /words long-session soak: study for N minutes on an iPhone-sized, muted
// Chromium and snapshot what the page holds every minute, to find what grows.
//
//   node scripts/qa/words-soak.mjs                       # QA_BASE=http://localhost:3000, 16 min
//   QA_BASE=http://localhost:3517 SOAK_MIN=3 node scripts/qa/words-soak.mjs
//   SOAK_OUT=/tmp/soak.json …                            # also write the rows as JSON
//
// Signs up a throwaway qa+soak<ts>@lianki.test account (dev password auth, so
// local wrangler dev / bun run dev only), adds a catalog list and studies it:
// taps (reveal + say), swipes that grade, scrolls, settings open/close, undo.
// Word audio is a stubbed silent WAV that really plays through the page's
// AudioContext, with Chromium's --mute-audio: nothing is audible.
//
// Each minute, after a forced GC: CDP Performance.getMetrics (heap, Nodes,
// JSEventListeners, Documents, Frames, LayoutCount, RecalcStyleCount), live
// objects by prototype (Runtime.queryObjects: HTMLAudioElement,
// MediaElementAudioSourceNode, GainNode, AudioContext, WebSocket,
// EventSource), pending timers and rAF callbacks (instrumented), blob URLs
// not revoked, performance entries, localStorage, storage estimate, the
// queue length, and the cost of a one-row scroll step (frame time, and the
// main thread's script / layout / style time from CDP). SOAK_CPU=4 throttles
// the CPU to read closer to a phone.
import { chromium, devices } from "playwright";
import { writeFileSync } from "node:fs";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const MINUTES = Number(process.env.SOAK_MIN || 16);
const EMAIL = `qa+soak${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

/** A valid 0.4 s silent 16-bit mono WAV: decodes and plays like a real clip. */
function silentWav(seconds = 0.4, rate = 8000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}
const WAV = silentWav();

const browser = await launchSilent(chromium, {
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await newSilentContext(browser, { ...devices["iPhone 13"] });
await ctx.addInitScript(() => {
  localStorage.setItem("lk:first-run", "account");
  // Pending timers and frames, and blob URLs, counted live.
  const live = { timeouts: new Set(), intervals: new Set(), rafs: new Set(), blobs: new Set() };
  window.__soak = live;
  // Clips started: the load the audio path is under.
  live.plays = 0;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    live.plays++;
    return play.apply(this, a);
  };
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
  const cou = URL.createObjectURL.bind(URL);
  const rou = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (o) => {
    const u = cou(o);
    live.blobs.add(u);
    return u;
  };
  URL.revokeObjectURL = (u) => {
    live.blobs.delete(u);
    rou(u);
  };
  // No browser voices (as on many phones): the server's clips speak.
  Object.defineProperty(window, "speechSynthesis", {
    value: {
      speak() {},
      cancel() {},
      getVoices: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
});
await ctx.route("**/api/words/tts?*", (r) => r.fulfill({ contentType: "audio/wav", body: WAV }));
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
// SOAK_CPU=4: a phone-like CPU (the scroll costs read closer to an iPhone's).
if (process.env.SOAK_CPU)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.SOAK_CPU) });

// ── sign up, add a list, open it ────────────────────────────────────────────
await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
await page.locator("#email").fill(EMAIL);
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForSelector("#password", { timeout: 10000 });
await page.locator("#password").fill(PW);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: 30000 });
await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
const catalog = await page.evaluate(
  async () => (await (await fetch("/words/index.json")).json()).lists,
);
const first = catalog.find((c) => c.lang === "fr") ?? catalog[0];
await page.getByRole("button", { name: first.lang, exact: true }).click();
await page.getByRole("button", { name: "add", exact: true }).first().click();
await page.locator('[role="listitem"]').first().waitFor({ timeout: 20000 });
console.error(`studying ${first.lang} as ${EMAIL} for ${MINUTES} min`);

// ── gestures (real touch events through CDP) ────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const touch = (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y }],
  });
/** A row well inside the visible part of the list. */
async function midRow(k = 0) {
  return page.evaluate((k) => {
    const top = document.querySelector("[data-words-top]").getBoundingClientRect().bottom;
    const rows = [...document.querySelectorAll('[role="listitem"]')]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.top > top + 60 && b.bottom < innerHeight - 140);
    const b = rows[Math.min(k, rows.length - 1)];
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  }, k);
}
async function swipe(dx) {
  const p = await midRow(2);
  if (!p) return;
  await sleep(200); // the list must rest 120 ms, or a touch catches a fling
  await touch("touchStart", p.x, p.y);
  for (let s = 1; s <= 8; s++) {
    await touch("touchMove", p.x + (dx * s) / 8, p.y);
    await sleep(16);
  }
  await touch("touchEnd");
  await sleep(350);
}
async function tap(k) {
  const p = await midRow(k);
  if (!p) return;
  await sleep(200);
  await touch("touchStart", p.x, p.y);
  await sleep(40);
  await touch("touchEnd");
  await sleep(400);
}
async function scroll(dy) {
  await cdp.send("Input.synthesizeScrollGesture", {
    x: 195,
    y: 400,
    yDistance: -dy,
    speed: 1200,
    gestureSourceType: "touch",
  });
  await sleep(300);
}
async function toggleSettings() {
  await page
    .getByRole("button", { name: /settings/i })
    .first()
    .click();
  await sleep(300);
  await page
    .getByRole("button", { name: /settings/i })
    .first()
    .click();
  await sleep(200);
}

// ── one snapshot ─────────────────────────────────────────────────────────────
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
const durations = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration };
};
async function frameCost() {
  const a = await durations();
  const f = await frames();
  const b = await durations();
  // Main-thread time per one-row scroll step, in ms (script = React's render).
  const per = (k) => +(((b[k] - a[k]) * 1000) / 20).toFixed(2);
  return { ...f, scriptMs: per("script"), layoutMs: per("layout"), styleMs: per("style") };
}
async function frames() {
  // 20 scroll steps of one row, each waited to the next frame.
  return page.evaluate(async () => {
    const el = document.querySelector('[role="list"]');
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    await frame();
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      el.scrollTop += i % 2 ? -44 : 44;
      el.dispatchEvent(new Event("scroll"));
      await frame();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { p50: +times[10].toFixed(1), max: +times[19].toFixed(1) };
  });
}
async function snapshot(minute) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const live = {};
  for (const c of [
    "HTMLAudioElement",
    "MediaElementAudioSourceNode",
    "GainNode",
    "AudioContext",
    "WebSocket",
    "EventSource",
    "IntersectionObserver",
    "ResizeObserver",
    "MutationObserver",
    "Animation",
  ])
    live[c] = await countOf(c).catch(() => null);
  const page_ = await page.evaluate(async () => {
    const s = window.__soak;
    const est = await navigator.storage?.estimate?.().catch(() => null);
    let ls = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls += k.length + (localStorage.getItem(k) ?? "").length;
    }
    const list = document.querySelector('[role="list"]');
    const pad = list ? Math.round(list.clientHeight * 0.8) : 0;
    return {
      dom: document.getElementsByTagName("*").length,
      rows: document.querySelectorAll('[role="listitem"]').length,
      queue: list ? Math.round((list.scrollHeight - 2 * pad) / 44) : 0,
      graded: Number(
        document.querySelector("[data-words-top]")?.textContent.match(/(\d+) done/)?.[1] ?? 0,
      ),
      plays: s.plays,
      timeouts: s.timeouts.size,
      intervals: s.intervals.size,
      rafs: s.rafs.size,
      blobs: s.blobs.size,
      perfEntries: performance.getEntries().length,
      lsKeys: localStorage.length,
      lsKB: +(ls / 1024).toFixed(1),
      storageKB: est ? Math.round(est.usage / 1024) : null,
    };
  });
  const cost = await frameCost();
  return {
    min: minute,
    heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1),
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    docs: m.Documents,
    frames: m.Frames,
    layouts: m.LayoutCount,
    recalcs: m.RecalcStyleCount,
    ...page_,
    audioEl: live.HTMLAudioElement,
    mediaSrc: live.MediaElementAudioSourceNode,
    gain: live.GainNode,
    actx: live.AudioContext,
    ws: live.WebSocket,
    es: live.EventSource,
    io: live.IntersectionObserver,
    ro: live.ResizeObserver,
    mo: live.MutationObserver,
    anim: live.Animation,
    scrollP50: cost.p50,
    scrollMax: cost.max,
    scrollScriptMs: cost.scriptMs,
    scrollLayoutMs: cost.layoutMs,
    scrollStyleMs: cost.styleMs,
  };
}

// ── the session ──────────────────────────────────────────────────────────────
const rows = [await snapshot(0)];
console.error(JSON.stringify(rows[0]));
const t0 = Date.now();
// SOAK_GROW=N: no study; N rounds of flinging to the end of the list (Endless
// loads more each time), a snapshot after each: the scroll cost against the
// queue's length.
for (let round = 1; round <= Number(process.env.SOAK_GROW || 0); round++) {
  for (let k = 0; k < 8; k++) {
    await page.evaluate(() => {
      const el = document.querySelector('[role="list"]');
      el.scrollTop = el.scrollHeight;
    });
    await sleep(700);
  }
  const r = await snapshot(round);
  rows.push(r);
  console.error(JSON.stringify(r));
}
for (let minute = 1; !process.env.SOAK_GROW && minute <= MINUTES; minute++) {
  while (Date.now() - t0 < minute * 60_000) {
    // About one round a 10 s: read two words, grade three, scroll, look at settings.
    await tap(1);
    await tap(3);
    await swipe(40); // Good
    await swipe(80); // Easy
    await swipe(-80); // Again: comes back within minutes
    await scroll(44 * 3);
    if (Math.random() < 0.3) await scroll(-44 * 6);
    if (Math.random() < 0.2) await toggleSettings();
    if (Math.random() < 0.1)
      await page
        .getByRole("button", { name: /undo/i })
        .first()
        .click()
        .catch(() => {});
  }
  const r = await snapshot(minute);
  rows.push(r);
  console.error(JSON.stringify(r));
}

const cols = Object.keys(rows[0]);
console.log(cols.join("\t"));
for (const r of rows) console.log(cols.map((c) => r[c]).join("\t"));
if (errs.length) console.log(`page errors: ${[...new Set(errs)].slice(0, 5).join(" | ")}`);
if (process.env.SOAK_OUT) writeFileSync(process.env.SOAK_OUT, JSON.stringify(rows, null, 2));
await browser.close();
