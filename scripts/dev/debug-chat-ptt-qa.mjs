#!/usr/bin/env bun
/**
 * Push to talk on the chat's mic (packages/debug-chat/src/ptt.ts; owner,
 * 2026-11-10 "长按说话"), in Chromium at iPhone size with CDP touch, on the
 * local /harness page with the hot widget, the fake mic (scripts/qa/silent.mjs)
 * and the STT route answered by the test:
 *
 *   - a long press shows the held state (data-ptt="held", the red ring);
 *     its release sends ONE line, the STT route called once, source "stt",
 *     with no draft left behind; the page does not scroll
 *   - a press slid away and released there sends nothing (cancel)
 *   - a short tap sends nothing (it toggles listening, as ever)
 *
 * Silent: muted browser, fake mic, nothing played.
 *
 *   bun scripts/dev/debug-chat-ptt-qa.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

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

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await launchSilent(chromium);
try {
  const ctx = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    permissions: ["microphone"],
  });
  await ctx.addInitScript((src) => {
    localStorage.setItem("lk:debug-widget-src", src);
    // Headless Chromium has no capture: a quiet tone from a context of its own
    // stands in for the mic (into a stream, never to the speakers).
    navigator.mediaDevices.getUserMedia = async () => {
      const c = new AudioContext();
      const o = c.createOscillator();
      const g = c.createGain();
      g.gain.value = 0.05;
      const d = c.createMediaStreamDestination();
      o.connect(g).connect(d);
      o.start();
      return d.stream;
    };
  }, `${ORIGIN}/debug-chat.js`);
  let sttCalls = 0;
  await ctx.route("**/api/debug/stt**", (r) => {
    sttCalls++;
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"text":"held line"}',
    });
  });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
  await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
  await page.evaluate(() => {
    const tall = document.createElement("div");
    tall.style.height = "3000px";
    document.body.append(tall);
  });
  await page.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(page);
  const mic = await page.locator('[data-testid="debug-chat-mic"]').boundingBox();
  const x = mic.x + mic.width / 2;
  const y = mic.y + mic.height / 2;
  const touch = (type, px = x, py = y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: px, y: py }],
    });
  const sent = () => page.evaluate(() => globalThis.__sent ?? []);
  const state = () =>
    page.evaluate(
      () => document.querySelector('[data-testid="debug-chat-mic"]')?.dataset.ptt ?? "idle",
    );

  // Long press: held, then one line on release.
  const y0 = await page.evaluate(() => scrollY);
  await touch("touchStart");
  await page.waitForTimeout(900);
  check((await state()) === "held", `held after a long press (${await state()})`);
  check(
    (await page.locator('[data-testid="debug-chat-mic-ptt"]').count()) === 1,
    "the held ring shows",
  );
  await touch("touchMove", x, y - 5);
  await page.waitForTimeout(400);
  await touch("touchEnd");
  await page.waitForTimeout(2500);
  let s = await sent();
  check(s.length === 1 && s[0].text === "held line", `one line sent (${JSON.stringify(s)})`);
  check(s[0]?.source === "stt", "the line is the mic's (source stt)");
  check(sttCalls === 1, `the STT route called once (${sttCalls})`);
  check((await page.evaluate(() => scrollY)) === y0, "the page did not scroll");
  const draft = await page.locator('[data-testid="debug-chat-input"]').inputValue();
  check(draft === "", `no draft left (${JSON.stringify(draft)})`);

  // Slide away and let go: cancelled.
  await touch("touchStart");
  await page.waitForTimeout(900);
  await touch("touchMove", x, y - 150);
  await page.waitForTimeout(100);
  check((await state()) === "away", `slid away arms the cancel (${await state()})`);
  await touch("touchEnd");
  await page.waitForTimeout(2000);
  s = await sent();
  check(s.length === 1, "a cancelled hold sends nothing");

  // A short tap: no line.
  await touch("touchStart");
  await page.waitForTimeout(80);
  await touch("touchEnd");
  await page.waitForTimeout(1500);
  check((await sent()).length === 1, "a short tap sends nothing");
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall push-to-talk checks passed");
