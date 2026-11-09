#!/usr/bin/env bun
/**
 * Browser checks for the chat's fold (packages/debug-chat/src/fold.ts) on the
 * local /harness page, as debug-chat-bar-qa.mjs does: open ⇄ pill. The third
 * level, tucked into the screen edge, is removed (owner, 2026-11-07 20:32 JST).
 *
 *   - the mark minimizes into the pill and stays under the pointer;
 *   - floating lines align from the pill's side (its left edge at the right
 *     edge of the screen), not by the screen third;
 *   - on the pill the mark opens the chat again; no handle ever shows;
 *   - a saved `tucked` falls back to the plain pill and is cleared;
 *   - the pill pushed against the left edge stays a pill there and everything
 *     mirrors (the mark on the inner side); the pill's Li opens the chat.
 *
 * getUserMedia is stubbed (refused): nothing is ever recorded or played.
 *
 *   bun scripts/dev/debug-chat-fold-qa.mjs [--shots <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const argv = process.argv.slice(2);
const shotsAt = argv.indexOf("--shots");
const SHOTS = shotsAt === -1 ? null : argv[shotsAt + 1];

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
const sel = (id) => `[data-testid="${id}"]`;
const W = 390;
const H = 844;

const browser = await launchSilent(chromium);
try {
  const ctx = await newSilentContext(browser, {
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  await ctx.addInitScript((src) => {
    localStorage.setItem("lk:debug-widget-src", src);
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("refused in QA", "NotAllowedError");
      };
  }, `${ORIGIN}/debug-chat.js`);
  const page = await ctx.newPage();
  const load = async (query) => {
    await page.goto(`${ORIGIN}/harness${query}`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    await page.waitForTimeout(400);
  };
  const box = (id) => page.locator(sel(id)).boundingBox();
  const fold = () => page.getAttribute("[data-debug-chat]", "data-fold");
  const edge = () => page.getAttribute("[data-debug-chat]", "data-edge");
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };

  await load("?open");
  await page.evaluate(() => localStorage.removeItem("lk:pref:chat-fold"));
  await load("?open");
  check((await fold()) === "open", "starts open");
  await shot("1-open");

  // Open → pill: the mark stays under the pointer.
  const m0 = await box("debug-chat-pill-min");
  await page.click(sel("debug-chat-pill-min"));
  await page.waitForTimeout(700); // the tap waits for a double, then the fold
  const m1 = await box("debug-chat-pill-min");
  check((await fold()) === "pill", "the mark folds into the pill");
  check(Math.abs(m1.x - m0.x) < 2 && Math.abs(m1.y - m0.y) < 2, "the mark stays under the pointer");

  // Floating lines from the pill's side.
  await page.evaluate(() => window.__push("a line that floats from the pill's side"));
  await page.waitForSelector(sel("debug-chat-float-box"), { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const fb = await box("debug-chat-float-box");
  const pill = await box("debug-chat-pill");
  check(
    !!fb && !!pill && (Math.abs(fb.x - pill.x) < 2 || fb.x + fb.width <= W - 8 + 1),
    `floating lines start at the pill's left (${fb?.x} vs ${pill?.x})`,
  );
  check(
    (await page.getAttribute(sel("debug-chat-float-box"), "data-side")) === "left",
    "floating lines align left at the right edge",
  );
  await shot("2-pill");

  // The third level, tucked into the edge, is removed (owner, 2026-11-07
  // 20:32 JST): on the pill the mark opens the chat again, and no handle.
  await page.click(sel("debug-chat-pill-min"));
  await page.waitForTimeout(900);
  check((await fold()) === "open", "on the pill the mark opens the chat (no tuck)");
  check((await page.locator(sel("debug-chat-handle")).count()) === 0, "no edge handle");
  await page.click(sel("debug-chat-pill-min"));
  await page.waitForTimeout(900);
  check((await fold()) === "pill", "the mark folds into the pill again");

  // A saved `tucked` (from before the removal) falls back to the plain pill.
  await page.evaluate(() => {
    localStorage.setItem("lk:debug-chat-open", "0");
    localStorage.setItem(
      "lk:pref:chat-fold",
      JSON.stringify({ state: { tucked: true, edge: "right" }, version: 1 }),
    );
  });
  await load("");
  check((await fold()) === "pill", "a saved tucked shows the plain pill");
  check((await page.locator(sel("debug-chat-handle")).count()) === 0, "and no handle");
  const sec = await page.locator("[data-debug-chat]").boundingBox();
  check(!!sec && sec.x < W && sec.x + sec.width <= W, "the pill is on screen");
  const cleared = await page.evaluate(
    () => JSON.parse(localStorage.getItem("lk:pref:chat-fold") ?? "{}").state?.tucked,
  );
  check(cleared === false, `the saved tucked is cleared (${cleared})`);
  await shot("3-pill-from-tucked");

  // Drag the pill (by its Li) against the left edge: it stays a pill there, mirrored.
  const li = await box("debug-chat-restore");
  await page.mouse.move(li.x + li.width / 2, li.y + li.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(li.x + li.width / 2 - (i * (W + 40)) / 12, li.y + li.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(900);
  check(
    (await fold()) === "pill" && (await edge()) === "left",
    `pushed against the left edge it stays a pill there (${await fold()}, ${await edge()})`,
  );
  check((await page.locator(sel("debug-chat-handle")).count()) === 0, "no tuck, no handle");
  const mk = await box("debug-chat-pill-min");
  const mic = await box("debug-chat-mic").catch(() => null);
  check(!!mk && (!mic || mk.x > mic.x), "mirrored: the mark on the inner side, right of the mic");
  await page.evaluate(() => window.__push("on the left the lines end at the pill's right"));
  await page.waitForTimeout(400);
  check(
    (await page.getAttribute(sel("debug-chat-float-box"), "data-side")) === "right",
    "mirrored: floating lines align right",
  );
  await shot("6-pill-left");

  // The pill's Li opens the chat.
  await page.click(sel("debug-chat-restore"));
  await page.waitForTimeout(500);
  check((await fold()) === "open", "the pill's Li opens the chat");
  await shot("7-open-left");
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall fold checks passed");
