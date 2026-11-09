#!/usr/bin/env bun
/**
 * Browser checks that the chat history scrolls by hand while the input has
 * the focus (owner, 2026-11-05 01:52 JST, iPhone PWA on /words: keyboard up,
 * the history would not drag; packages/debug-chat/src/log-surface.ts
 * LOG_TOUCH), on the local /harness page with the hot widget:
 *
 *   - WebKit, 390×844 touch: with the input focused, the history's empty
 *     area hit-tests to the history (not the page under the click-through
 *     box), a scroll gesture over it (wheel; Playwright's WebKit cannot
 *     drive a native touch drag) moves its scrollTop, and the input keeps
 *     the focus
 *   - Chromium, 390×844 touch: a real touch drag (CDP) on the history moves
 *     its scrollTop, and the input keeps the focus
 *   - at rest (input not focused), the history's empty area is still
 *     click-through
 *   - Chromium at rest (owner, 2026-11-10, /reader): a touch drag over the
 *     history, or one starting on a link in it, scrolls the page under it
 *     and leaves the history where it was; the link still hit-tests
 *
 * Browsers are muted (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-typing-scroll-qa.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium, webkit } from "playwright";
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
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(what);
};

const COL = '[data-testid="debug-chat-column"]';
const INPUT = '[data-testid="debug-chat-input"]';

async function setup(type) {
  const browser = await launchSilent(type);
  const ctx = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: type === chromium,
  });
  await ctx.addInitScript((src) => {
    localStorage.setItem("lk:debug-widget-src", src);
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("refused in QA", "NotAllowedError");
      };
  }, `${ORIGIN}/debug-chat.js`);
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
  await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    for (let i = 0; i < 60; i++)
      globalThis.__push(
        `#${i}# ${"这是一条很长的聊天记录，用来测试滚动。".repeat(1 + (i % 3))}`,
        i % 2 ? "agent" : "owner",
      );
  });
  await page.waitForTimeout(400);
  return { browser, ctx, page };
}

/** The history's top, whether the input has the focus, and what its right edge hit-tests to. */
const state = (page) =>
  page.evaluate(
    ([col, input]) => {
      const el = document.querySelector(col);
      const b = el.getBoundingClientRect();
      // The right end of a row, past most lines' text: the empty part of the history.
      const hit = document.elementFromPoint(b.right - 4, b.top + b.height / 2);
      return {
        top: Math.round(el.scrollTop),
        focused: document.activeElement === document.querySelector(input),
        hitsLog: !!hit && el.contains(hit),
        x: b.right - 4,
        y: b.top + b.height / 2,
      };
    },
    [COL, INPUT],
  );

try {
  // WebKit (the owner's iPhone engine).
  {
    const { browser, page } = await setup(webkit);
    let s = await state(page);
    check(!s.hitsLog, "webkit: at rest the history's empty area is click-through");
    await page.locator(INPUT).focus();
    await page.waitForTimeout(400);
    s = await state(page);
    check(s.focused, "webkit: the input has the focus");
    check(s.hitsLog, "webkit: focused, the history takes the touch");
    const before = s.top;
    await page.mouse.move(s.x, s.y);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
    s = await state(page);
    check(
      s.top < before,
      "webkit: focused, a scroll over the history moves it",
      `${before} → ${s.top}`,
    );
    check(s.focused, "webkit: the input keeps the focus");
    await browser.close();
  }
  // Chromium: a real touch drag.
  {
    const { browser, ctx, page } = await setup(chromium);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    await page.locator(INPUT).focus();
    await page.waitForTimeout(400);
    let s = await state(page);
    check(s.hitsLog, "chromium: focused, the history takes the touch");
    const before = s.top;
    await touch("touchStart", s.x, s.y - 40);
    for (let dy = 10; dy <= 120; dy += 10) {
      await touch("touchMove", s.x, s.y - 40 + dy);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd");
    await page.waitForTimeout(500);
    const after = await state(page);
    check(
      after.top < before,
      "chromium: a touch drag scrolls the history",
      `${before} → ${after.top}`,
    );
    check(after.focused, "chromium: the input keeps the focus (the keyboard stays)");
    await browser.close();
  }
  // Chromium at rest (owner, 2026-11-10, /reader): a drag over the history,
  // even one starting on a link in it, scrolls the page underneath.
  {
    const { browser, ctx, page } = await setup(chromium);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    await page.evaluate(() => {
      const tall = document.createElement("div");
      tall.style.height = "4000px";
      document.body.append(tall);
      globalThis.__push("Read on at https://example.com/article now", "agent");
    });
    await page.waitForTimeout(400);
    const link = await page.evaluate((col) => {
      const a = document.querySelector(`${col} a[href^="https://example.com"]`);
      if (!a) return null;
      // Its first line box (a wrapped link's bounding box covers other text).
      const r = a.getClientRects()[0];
      const x = r.left + Math.min(8, r.width / 2);
      const y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hit: !!at && a.contains(at),
        what: at ? `${at.tagName}.${at.className}` : "none",
        logTop: document.querySelector(col).scrollTop,
      };
    }, COL);
    check(!!link, "chromium: the link line is in the history");
    if (link) {
      check(link.hit, "chromium: at rest, a link in the history still takes a tap", link.what);
      const y0 = await page.evaluate(() => scrollY);
      await touch("touchStart", link.x, link.y);
      for (let dy = 10; dy <= 150; dy += 10) {
        await touch("touchMove", link.x, link.y - dy);
        await page.waitForTimeout(16);
      }
      await touch("touchEnd");
      await page.waitForTimeout(500);
      const after = await page.evaluate(
        (col) => ({ y: scrollY, logTop: document.querySelector(col).scrollTop }),
        COL,
      );
      check(
        after.y > y0,
        "chromium: at rest, a drag from a link scrolls the page",
        `${y0} → ${after.y}`,
      );
      check(
        after.logTop === link.logTop,
        "chromium: at rest, that drag leaves the history where it was",
      );
    }
    const s = await state(page);
    const y1 = await page.evaluate(() => scrollY);
    await touch("touchStart", s.x, s.y);
    for (let dy = 10; dy <= 150; dy += 10) {
      await touch("touchMove", s.x, s.y - dy);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd");
    await page.waitForTimeout(500);
    const y2 = await page.evaluate(() => scrollY);
    check(y2 > y1, "chromium: at rest, a drag over the history scrolls the page", `${y1} → ${y2}`);
    await browser.close();
  }
} finally {
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall typing-scroll checks passed");
