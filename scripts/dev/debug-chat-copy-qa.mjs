#!/usr/bin/env bun
/**
 * Browser checks for copying chat lines (packages/debug-chat/src/copy-line.ts)
 * and the + menu's opaque look (typing-glass.ts inputInUse), on the local
 * /harness page with the hot widget (its Tailwind CSS too), at 390×844 with
 * touch, as on the owner's iPhone:
 *
 *   - a line's text takes the pointer and is selectable (computed
 *     pointer-events not none, user-select / -webkit-user-select not none),
 *     though the box around it is click-through
 *   - its copy button writes the line's plain text (navigator.clipboard is
 *     mocked) and says "Copied"
 *   - idle, the panel is faint; a tap on + makes it opaque, and closing the
 *     menu returns it to idle
 *
 * getUserMedia is stubbed (refused): nothing is recorded. Browsers are muted
 * (scripts/qa/silent.mjs).
 *
 *   bun scripts/dev/debug-chat-copy-qa.mjs [--shots <dir>]
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
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
  for (const scheme of ["light", "dark"]) {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      hasTouch: true,
      isMobile: true,
    });
    await ctx.addInitScript((src) => {
      localStorage.setItem("lk:debug-widget-src", src);
      globalThis.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t) => void globalThis.__copied.push(t) },
      });
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException("refused in QA", "NotAllowedError");
        };
    }, `${ORIGIN}/debug-chat.js`);
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/harness?open&nofrontier`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    await page.waitForTimeout(400);
    const text = "好的，我先把复制修好。";
    await page.evaluate((t) => globalThis.__push(t, "agent"), text);
    await page.waitForTimeout(200);

    const line = page.locator('[data-testid="debug-chat-line"]').last();
    const st = await line.evaluate((el) => {
      const c = getComputedStyle(el);
      const box = getComputedStyle(el.closest("[data-debug-chat]"));
      return {
        pe: c.pointerEvents,
        us: c.userSelect,
        wus: c.webkitUserSelect,
        boxPe: box.pointerEvents,
      };
    });
    check(st.boxPe === "none", `${scheme}: the box stays click-through`);
    check(st.pe !== "none", `${scheme}: the line takes the pointer (${st.pe})`);
    check(st.us !== "none" && st.wus !== "none", `${scheme}: the line is selectable (${st.us})`);

    const copy = line.locator('[data-testid="debug-chat-copy"]');
    check((await copy.count()) === 1, `${scheme}: the line has a copy button`);
    check(!!(await copy.getAttribute("aria-label")), `${scheme}: the copy button has a label`);
    await copy.tap();
    await page.waitForTimeout(100);
    const copied = await page.evaluate(() => globalThis.__copied);
    check(copied.at(-1) === text, `${scheme}: it copied the plain text`);
    check((await copy.getAttribute("data-copied")) !== null, `${scheme}: it says copied`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `copy-${scheme}.png`) });

    // The + menu: opaque while it is up, idle again once it closes.
    const chat = page.locator("[data-debug-chat]");
    const opacity = () => chat.evaluate((el) => Number(getComputedStyle(el).opacity));
    await page.locator("body").tap({ position: { x: 20, y: 20 } });
    await page.waitForTimeout(400);
    check((await opacity()) < 1, `${scheme}: idle, the panel is faint`);
    const plus = page.locator('[data-testid="debug-chat-attach"]');
    await plus.tap();
    await page.waitForTimeout(400);
    check((await opacity()) === 1, `${scheme}: the + menu makes it opaque`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `plus-${scheme}.png`) });
    await page.keyboard.press("Escape");
    await page.locator("body").tap({ position: { x: 20, y: 20 } });
    await page.waitForTimeout(400);
    check((await opacity()) < 1, `${scheme}: closed, it is faint again`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall copy checks passed");
