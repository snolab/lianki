#!/usr/bin/env bun
/**
 * Browser checks that the chat history is glass at rest (owner, 2026-11-05
 * 13:00 JST, Mac Chrome on /books; packages/debug-chat/src/log-engage.ts),
 * on the local /harness page with the hot widget, over a tall page with a
 * button right under the history:
 *
 *   - Chromium and WebKit, 1280×800 mouse, light and dark: at rest a wheel
 *     over the history scrolls the page, and a click over it reaches the
 *     page's button
 *   - focused input: a wheel over the history scrolls the history, the page
 *     stays, the input keeps the focus; a drag on a line then selects its
 *     text, and the history stays open and engaged (the press blurred the
 *     input: held "open")
 *   - the copy path: with the input not focused, a press-and-hold on a line
 *     selects that line's text, the button under it is not clicked, and the
 *     history now takes the pointer (a drag then selects part of a line); a
 *     click on the page outside the chat makes it glass again
 *   - Chromium, 390×844 touch (CDP): the same hold with a finger selects the
 *     line and does not tap the button; a plain tap still does
 *
 * Browsers are muted (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-passthrough-qa.mjs [--shots <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
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
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(what);
};

const COL = '[data-testid="debug-chat-column"]';
const INPUT = '[data-testid="debug-chat-input"]';
const LINE = '[data-testid="debug-chat-line"]';

async function setup(type, { touch = false, scheme = "light" } = {}) {
  const browser = await launchSilent(type);
  const ctx = await newSilentContext(browser, {
    viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    hasTouch: touch,
    isMobile: touch && type === chromium,
    colorScheme: scheme,
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
    for (let i = 0; i < 30; i++)
      globalThis.__push(
        `#${i}# ${"这是一条很长的聊天记录，用来测试滚动。".repeat(1 + (i % 3))}`,
        i % 2 ? "agent" : "owner",
      );
  });
  await page.waitForTimeout(400);
  // A tall page, and a button under the history (below the chat's layer).
  await page.evaluate((col) => {
    const tall = document.createElement("div");
    tall.style.height = "4000px";
    document.body.append(tall);
    const b = document.querySelector(col).getBoundingClientRect();
    const btn = document.createElement("button");
    btn.id = "under";
    btn.textContent = "under";
    Object.assign(btn.style, {
      position: "fixed",
      left: `${b.left}px`,
      top: `${b.top}px`,
      width: `${b.width}px`,
      height: `${b.height}px`,
      zIndex: "1",
    });
    globalThis.__clicks = 0;
    btn.addEventListener("click", () => globalThis.__clicks++);
    document.body.append(btn);
  }, COL);
  return { browser, ctx, page };
}

const state = (page) =>
  page.evaluate(
    ([col, input, line]) => {
      const el = document.querySelector(col);
      const b = el.getBoundingClientRect();
      const lines = [...el.querySelectorAll(line)];
      // The last line wholly in view (the log may be scrolled up).
      const seen =
        lines
          .filter((l) => {
            const r = l.getBoundingClientRect();
            return r.top >= b.top && r.bottom <= b.bottom;
          })
          .at(-1) ?? lines.at(-1);
      const last = seen.getBoundingClientRect();
      return {
        x: b.left + b.width / 2,
        y: b.top + b.height / 2,
        lineX: last.left + Math.min(20, last.width / 2),
        lineY: last.top + Math.min(8, last.height / 2),
        lineText: seen.textContent,
        logTop: Math.round(el.scrollTop),
        h: Math.round(b.height),
        pageY: Math.round(scrollY),
        clicks: globalThis.__clicks,
        focused: document.activeElement === document.querySelector(input),
        pe: getComputedStyle(el).pointerEvents,
        selection: String(getSelection()),
      };
    },
    [COL, INPUT, LINE],
  );

const picked = (sel, text) => sel.trim().length > 0 && text.includes(sel.trim().slice(0, 10));

async function mouseChecks(type, name, scheme) {
  const { browser, page } = await setup(type, { scheme });
  const tag = `${name} ${scheme}`;
  try {
    let s = await state(page);
    check(s.pe === "none", `${tag}: at rest the history takes no pointer`, s.pe);
    // A wheel over the history scrolls the page.
    await page.mouse.move(s.lineX, s.lineY);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);
    let t = await state(page);
    check(
      t.pageY > s.pageY,
      `${tag}: at rest a wheel over the history scrolls the page`,
      `${s.pageY} → ${t.pageY}`,
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(200);
    // A click over a line reaches the page's button.
    s = await state(page);
    await page.mouse.click(s.lineX, s.lineY);
    await page.waitForTimeout(200);
    t = await state(page);
    check(
      t.clicks === s.clicks + 1,
      `${tag}: at rest a click over the history reaches the page`,
      `${s.clicks} → ${t.clicks}`,
    );

    // Focused: the wheel scrolls the history, not the page.
    await page.locator(INPUT).click();
    await page.waitForTimeout(400);
    s = await state(page);
    check(s.focused, `${tag}: the input has the focus`);
    check(s.pe !== "none", `${tag}: focused, the history takes the pointer`, s.pe);
    await page.mouse.move(s.x, s.y);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
    t = await state(page);
    check(
      t.logTop < s.logTop,
      `${tag}: focused, a wheel over the history scrolls it`,
      `${s.logTop} → ${t.logTop}`,
    );
    check(t.pageY === s.pageY, `${tag}: focused, the page stays`, `${s.pageY} → ${t.pageY}`);
    check(t.focused, `${tag}: the input keeps the focus`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `focused-${name}-${scheme}.png`) });
    // Focused, a drag on a line selects its text, and the history stays engaged.
    s = await state(page);
    await page.mouse.move(s.lineX, s.lineY);
    await page.mouse.down();
    await page.mouse.move(s.lineX + 80, s.lineY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    t = await state(page);
    check(
      t.selection.trim().length > 0 && s.lineText.includes(t.selection.trim()),
      `${tag}: focused, a drag selects part of a line`,
      JSON.stringify(t.selection),
    );
    check(t.pe !== "none", `${tag}: selecting keeps the history engaged`, t.pe);
    check(
      t.h === s.h,
      `${tag}: the history stays open while selecting (the press took the focus)`,
      `${s.h} → ${t.h}`,
    );

    // Unfocused again: a click on the page far from the chat.
    await page.mouse.click(20, 20);
    await page.waitForTimeout(600);
    s = await state(page);
    check(!s.focused && s.pe === "none", `${tag}: blurred, the history is glass again`, s.pe);

    // The copy path: press and hold a line.
    await page.mouse.move(s.lineX, s.lineY);
    await page.mouse.down();
    await page.waitForTimeout(750);
    await page.mouse.up();
    await page.waitForTimeout(300);
    t = await state(page);
    check(
      picked(t.selection, s.lineText),
      `${tag}: a press-and-hold selects the line under it`,
      JSON.stringify(t.selection.slice(0, 40)),
    );
    check(
      t.clicks === s.clicks,
      `${tag}: the hold does not click the page under it`,
      `${s.clicks} → ${t.clicks}`,
    );
    check(t.pe !== "none", `${tag}: after the hold the history takes the pointer`, t.pe);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `held-${name}-${scheme}.png`) });
    // A drag on the line now selects within the chat (a click first: a press
    // inside a selection would drag the selected text instead).
    await page.mouse.click(t.lineX + 4, t.lineY);
    await page.waitForTimeout(300);
    await page.mouse.move(t.lineX, t.lineY);
    await page.mouse.down();
    await page.mouse.move(t.lineX + 80, t.lineY, { steps: 5 });
    await page.mouse.up();
    const dragged = (await state(page)).selection;
    check(
      dragged.trim().length > 0 && t.lineText.includes(dragged.trim()),
      `${tag}: then a drag selects part of a line`,
      JSON.stringify(dragged),
    );
    // A press on the page outside the chat makes it glass again.
    await page.mouse.click(20, 20);
    await page.waitForTimeout(300);
    s = await state(page);
    check(s.pe === "none", `${tag}: a click outside the chat makes it glass again`, s.pe);
  } finally {
    await browser.close();
  }
}

async function touchHold() {
  const { browser, ctx, page } = await setup(chromium, { touch: true });
  try {
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    const s = await state(page);
    await touch("touchStart", s.lineX, s.lineY);
    await page.waitForTimeout(750);
    await touch("touchEnd");
    await page.waitForTimeout(400);
    const t = await state(page);
    check(
      picked(t.selection, s.lineText),
      "chromium touch: a finger's hold selects the line",
      JSON.stringify(t.selection.slice(0, 40)),
    );
    check(
      t.clicks === s.clicks,
      "chromium touch: the hold does not tap the page under it",
      `${s.clicks} → ${t.clicks}`,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "held-touch.png") });
    // A tap outside drops it; a plain tap over the history reaches the page.
    await page.touchscreen.tap(20, 20);
    await page.waitForTimeout(300);
    const u = await state(page);
    await page.touchscreen.tap(u.lineX, u.lineY);
    await page.waitForTimeout(300);
    const v = await state(page);
    check(
      v.clicks === u.clicks + 1,
      "chromium touch: at rest a tap over the history reaches the page",
      `${u.clicks} → ${v.clicks}`,
    );
  } finally {
    await browser.close();
  }
}

try {
  for (const scheme of ["light", "dark"]) {
    await mouseChecks(chromium, "chromium", scheme);
    await mouseChecks(webkit, "webkit", scheme);
  }
  await touchHold();
} finally {
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passthrough checks passed");
