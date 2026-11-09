#!/usr/bin/env bun
/**
 * The ETA bar never under the chat's floating buttons (owner, 2026-11-08 19:58
 * JST, Android: while scrolling the history, the full-screen button, the jump
 * buttons and the ETA bar sat in one spot). On the local /harness page with
 * timed tasks and a long log, at Android (412×915) and iPhone (390×844) sizes in
 * light and dark: the log is scrolled up (the scroll-down button shows) with
 * an ask above (the ask-jump button shows), with the input focused and not, and
 * (and in full screen) no two of the ETA bar, the scroll-down button, the ask-jump button and the
 * full-screen button overlap.
 *
 *   bun scripts/dev/debug-chat-eta-overlap-qa.mjs [--shots <dir>]
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
const IDS = [
  "debug-chat-eta-bar",
  "debug-chat-bottom",
  "debug-chat-ask-jump",
  "debug-chat-fullscreen-exit",
];
const overlap = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const browser = await launchSilent(chromium);
try {
  for (const [w, h, device] of [
    [412, 915, "android"],
    [390, 844, "iphone"],
  ])
    for (const scheme of ["light", "dark"])
      for (const mode of ["", "full"]) {
        const ctx = await newSilentContext(browser, {
          viewport: { width: w, height: h },
          deviceScaleFactor: 2,
          colorScheme: scheme,
          hasTouch: true,
        });
        await ctx.addInitScript((src) => {
          localStorage.setItem("lk:debug-widget-src", src);
          if (navigator.mediaDevices)
            navigator.mediaDevices.getUserMedia = async () => {
              throw new DOMException("refused in QA", "NotAllowedError");
            };
        }, `${ORIGIN}/debug-chat.js`);
        const page = await ctx.newPage();
        await page.goto(`${ORIGIN}/harness?open&nofrontier&eta${mode ? `&${mode}` : ""}`);
        await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
        const now = await page.evaluate(() => Date.now());
        await page.evaluate(
          (t) => globalThis.__etaSet(t),
          [
            { id: "/a", title: "Native swipe", start: now - 10 * MIN, at: now + 15 * MIN },
            { id: "/b", title: "PDF import", start: now - 5 * MIN, at: now + 5 * MIN },
          ],
        );
        // An ask, then a long log under it: scrolled up, both jump buttons show.
        await page.evaluate(() => {
          globalThis.__ask?.({
            askId: "q1",
            questions: [
              {
                id: "q",
                question: "Ship it?",
                options: [
                  { id: "y", label: "Yes" },
                  { id: "n", label: "No" },
                ],
              },
            ],
          });
          for (let i = 0; i < 40; i++) globalThis.__push(`line ${i} of a long history`);
        });
        await page.waitForTimeout(400);
        for (const focused of [false, true]) {
          if (focused) await page.locator("[data-debug-chat] textarea").first().focus();
          await page.waitForTimeout(300);
          // Scroll the log up, as a drag would.
          await page.evaluate(() => {
            const logs = [...document.querySelectorAll("[data-debug-chat] *")].filter(
              (e) =>
                e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== "visible",
            );
            for (const l of logs) {
              l.scrollTop = Math.max(0, l.scrollTop - 400);
              l.dispatchEvent(new Event("scroll"));
            }
          });
          await page.waitForTimeout(500);
          const boxes = {};
          for (const id of IDS) {
            const el = page.locator(`[data-testid="${id}"]`).first();
            if ((await el.count()) && (await el.isVisible())) boxes[id] = await el.boundingBox();
          }
          const tag = `${device} ${scheme}${mode ? ` ${mode}` : ""}${focused ? " focused" : ""}`;
          check(!!boxes["debug-chat-eta-bar"], `${tag}: the ETA bar shows`);
          check(!!boxes["debug-chat-bottom"], `${tag}: scrolled up, the scroll-down button shows`);
          const names = Object.keys(boxes);
          for (let i = 0; i < names.length; i++)
            for (let j = i + 1; j < names.length; j++)
              check(
                !overlap(boxes[names[i]], boxes[names[j]]),
                `${tag}: ${names[i]} and ${names[j]} do not overlap`,
              );
          if (SHOTS) {
            mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({
              path: join(
                SHOTS,
                `eta-overlap-${device}-${scheme}${mode ? `-${mode}` : ""}${focused ? "-focused" : ""}.png`,
              ),
            });
          }
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
console.log("all ETA overlap checks passed");
