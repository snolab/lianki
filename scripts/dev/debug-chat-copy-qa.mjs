#!/usr/bin/env bun
/**
 * Browser checks for copying chat lines (packages/debug-chat/src/copy-line.ts)
 * and the + menu's opaque look (typing-glass.ts inputInUse), on the local
 * /harness page with the hot widget (its Tailwind CSS too), at 390×844 with
 * touch, as on the owner's iPhone:
 *
 *   - a line's text is selectable (user-select / -webkit-user-select not
 *     none); at rest it leaves the pointer to the page (log-engage.ts), with
 *     the input focused it takes it (the press-and-hold path is in
 *     debug-chat-passthrough-qa.mjs)
 *   - its text selects, and there is no per-line copy button (owner,
 *     2026-11-05 02:00 JST: long-press → Copy is enough)
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

const q = (page) => page.locator('[data-testid="debug-chat-copy"]').count();
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
    const st = async () =>
      line.evaluate((el) => {
        const c = getComputedStyle(el);
        const box = getComputedStyle(el.closest("[data-debug-chat]"));
        return {
          pe: c.pointerEvents,
          us: c.userSelect,
          wus: c.webkitUserSelect,
          boxPe: box.pointerEvents,
        };
      });
    let st0 = await st();
    check(st0.boxPe === "none", `${scheme}: the box stays click-through`);
    // At rest the history is glass (log-engage.ts); the input focused, its lines take the finger.
    check(
      st0.pe === "none",
      `${scheme}: at rest the line leaves the pointer to the page (${st0.pe})`,
    );
    check(st0.us !== "none" && st0.wus !== "none", `${scheme}: the line is selectable (${st0.us})`);
    await page.locator('[data-testid="debug-chat-input"]').focus();
    await page.waitForTimeout(300);
    st0 = await st();
    check(st0.pe !== "none", `${scheme}: focused, the line takes the pointer (${st0.pe})`);
    await page.locator('[data-testid="debug-chat-input"]').blur();
    await page.waitForTimeout(300);

    // No per-line copy button (owner, 2026-11-05 02:00 JST): long-press → Copy is enough.
    check((await q(page)) === 0, `${scheme}: no copy button on the lines`);
    // The line's text can be selected as a whole (what a long-press and its handles do).
    const picked = await line.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return s.toString();
    });
    check(picked.includes(text), `${scheme}: the line's text selects`);
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
