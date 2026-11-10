#!/usr/bin/env bun
/**
 * Browser checks for the chat's ETA bar (packages/debug-chat/src/eta.ts,
 * EtaBar.tsx) on the local /harness page (`?eta`), with a fake clock
 * (Playwright's page.clock), at iPhone size in light and dark:
 *
 *   - two timed tasks: one line above the input, "2 tasks · 15m left · next in 5m",
 *     one row high, inside the phone's width
 *   - the clock runs 5 minutes: the first estimate passes, the page's one
 *     timer reports it once (__etaDue), the line moves on
 *   - a revised estimate moves the line
 *   - a tap opens the state tree, listing each task, its line filled to its progress, and its time left
 *   - a done task leaves after a moment
 *
 * Browsers are muted (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-eta-qa.mjs [--shots <dir>]
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
const MIN = 60_000;
const T0 = Date.parse("2026-11-07T10:20:00Z");

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
const tasks = (over = {}) => [
  {
    id: "/words/swipe",
    title: "Native swipe",
    start: T0 - 10 * MIN,
    at: T0 + 15 * MIN,
    ...over.swipe,
  },
  { id: "/read/pdf", title: "PDF import", start: T0 - 5 * MIN, at: T0 + 5 * MIN, ...over.pdf },
];

try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      hasTouch: false,
    });
    await ctx.addInitScript((src) => {
      localStorage.setItem("lk:debug-widget-src", src);
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException("refused in QA", "NotAllowedError");
        };
    }, `${ORIGIN}/debug-chat.js`);
    const page = await ctx.newPage();
    await page.clock.install({ time: T0 });
    await page.goto(`${ORIGIN}/harness?open&nofrontier&eta`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    await page.evaluate((t) => globalThis.__etaSet(t), tasks());
    await page.clock.runFor(300);
    const bar = page.locator('[data-testid="debug-chat-eta-bar"]');
    const text = () => page.locator('[data-testid="debug-chat-eta-text"]').innerText();
    check(await bar.isVisible(), `${scheme}: the bar shows above the input`);
    check(
      (await text()) === "2 tasks · 15m left · next in 5m",
      `${scheme}: summary (${await text()})`,
    );
    const box = await bar.boundingBox();
    check(
      !!box && box.height <= 26 && box.x >= 0 && box.x + box.width <= 390,
      `${scheme}: one row, inside 390 px (${JSON.stringify(box)})`,
    );
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    check(wide <= 390, `${scheme}: no sideways scroll (${wide})`);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `eta-bar-${scheme}.png`) });
    }

    // Five minutes on: the first estimate passes; this page reports it once.
    await page.clock.runFor(5 * MIN + 1000);
    const due = await page.evaluate(() => globalThis.__etaDue ?? []);
    check(
      JSON.stringify(due) === '["/read/pdf"]',
      `${scheme}: the timer reported the passed estimate once (${JSON.stringify(due)})`,
    );
    check((await text()) === "2 tasks · 10m left", `${scheme}: line moved on (${await text()})`);
    await page.clock.runFor(2 * MIN);
    check(
      (await page.evaluate(() => (globalThis.__etaDue ?? []).length)) === 1,
      `${scheme}: no second report while it stays unsent`,
    );

    // A revised estimate moves the bar.
    await page.evaluate((t) => globalThis.__etaSet(t), tasks({ swipe: { at: T0 + 40 * MIN } }));
    await page.clock.runFor(300);
    check((await text()) === "2 tasks · 33m left", `${scheme}: revised estimate (${await text()})`);

    // A tap opens the status area: the tree, with every timed task.
    await bar.click();
    await page.clock.runFor(400);
    // The list folds tasks into categories (gantt-groups.ts): open each to list its tasks.
    const toggles = page.locator('[data-testid="debug-chat-eta-toggle"]');
    check((await toggles.count()) === 2, `${scheme}: one category row each (words, import)`);
    for (let i = 0; i < (await toggles.count()); i++) await toggles.nth(i).click();
    await page.clock.runFor(100);
    const rows = page.locator('[data-testid="debug-chat-eta-row"]');
    check((await rows.count()) === 2, `${scheme}: the tree lists both tasks`);
    const states = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
    check(
      JSON.stringify(states) === '["reached","running"]',
      `${scheme}: row states ${JSON.stringify(states)}`,
    );
    const rowText = await rows.nth(1).innerText();
    check(rowText.includes("33m left"), `${scheme}: a row shows its time left (${rowText})`);
    if (SHOTS) {
      // CSS fades run on real time, not the fake clock.
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS, `eta-tree-${scheme}.png`) });
    }

    // Done: it stays a moment, then leaves.
    const now = await page.evaluate(() => Date.now());
    await page.evaluate(
      (t) => globalThis.__etaSet(t),
      tasks({ swipe: { at: T0 + 40 * MIN }, pdf: { done: true, doneAt: now } }),
    );
    await page.clock.runFor(300);
    check((await rows.count()) === 2, `${scheme}: a done task stays a moment`);
    await page.clock.runFor(9_000);
    check((await rows.count()) === 1, `${scheme}: then leaves`);

    // Minimized: the in-progress line is the nearest task and the last, in minutes.
    await page.goto(`${ORIGIN}/harness?min&nofrontier&eta`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    const t1 = await page.evaluate(() => Date.now());
    await page.evaluate(
      (t) => globalThis.__etaSet(t),
      [
        {
          id: "/box",
          title: "Box ETA: the bar on the owner's box",
          start: t1 - 10 * MIN,
          at: t1 + 40 * MIN,
        },
        {
          id: "/box/fill",
          title: "Fill line: the bar's own background",
          start: t1 - 5 * MIN,
          at: t1 + 5 * MIN,
        },
      ],
    );
    await page.clock.runFor(300);
    const eta = page.locator('[data-testid="debug-chat-frontier-eta"]');
    check(await eta.isVisible(), `${scheme}: minimized, the two ends show`);
    const full = await eta.getAttribute("title");
    check(full === "Fill line 5 min · Box ETA 40 min", `${scheme}: minimized line (${full})`);
    const eb = await eta.boundingBox();
    check(!!eb && eb.x >= 0 && eb.x + eb.width <= 390, `${scheme}: inside 390 px`);
    if (SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS, `eta-min-${scheme}.png`) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all ETA bar checks passed");
