#!/usr/bin/env bun
/**
 * Browser checks for the chat's selection fence (packages/debug-chat/src/
 * select-fence.ts; owner, 2026-11-05 11:05 JST, Mac Chrome: a drag from a
 * chat line that went past the box selected half the page). On the local
 * /harness page with the hot widget, page text all around the box, a mouse:
 *
 *   - a drag that starts on a chat line and ends far outside the chat (over
 *     the page text above it, then below it) leaves a selection whose anchor
 *     and focus are both in the chat, with none of the page's text in it
 *   - the page goes non-selectable only during that: after the drag, a drag
 *     on the page text selects page text as before
 *   - an iOS-handle-like move (the focus set outside by script) is put back
 *
 * The history is engaged first by a press-and-hold (log-engage.ts): at rest
 * it takes no pointer.
 *
 * Chromium and WebKit (desktop, 1280×800). Browsers are muted
 * (scripts/qa/silent.mjs); getUserMedia refused: nothing is recorded.
 *
 *   bun scripts/dev/debug-chat-select-fence-qa.mjs
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
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const PAGE_WORD = "PAGETEXT";
/** Where the selection is: its ends in the chat or not, and whether page text is in it. */
const where = (page) =>
  page.evaluate((word) => {
    const s = getSelection();
    const inChat = (n) =>
      !!(n && (n.nodeType === 1 ? n : n.parentElement)?.closest("[data-debug-chat]"));
    const text = s ? s.toString() : "";
    return {
      collapsed: !s || s.isCollapsed,
      anchor: inChat(s?.anchorNode),
      focus: inChat(s?.focusNode),
      page: text.includes(word),
      len: text.length,
      fenced: document.documentElement.hasAttribute("data-lk-chat-selecting"),
    };
  }, PAGE_WORD);

try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await launchSilent(type);
    const ctx = await newSilentContext(browser, { viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((src) => {
      localStorage.setItem("lk:debug-widget-src", src);
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException("refused in QA", "NotAllowedError");
        };
    }, `${ORIGIN}/debug-chat.js`);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`${ORIGIN}/harness?open&nofrontier`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    // Page text all over, before and after the chat in the document.
    await page.evaluate((word) => {
      const para = (i) => {
        const p = document.createElement("p");
        p.className = "lk-qa-page";
        p.style.cssText = "margin:0;font:16px/24px sans-serif";
        p.textContent = `${word} ${i} `.repeat(40);
        return p;
      };
      const before = document.createElement("div");
      for (let i = 0; i < 30; i++) before.append(para(i));
      document.body.prepend(before);
      const after = document.createElement("div");
      for (let i = 30; i < 40; i++) after.append(para(i));
      document.body.append(after);
    }, PAGE_WORD);
    for (let i = 0; i < 6; i++)
      await page.evaluate(
        (t) => globalThis.__push(t, "agent"),
        `第${i}行：选中这一行的文字，拖到聊天框外面也不会选中页面。`,
      );
    await page.waitForTimeout(400);

    const line = page.locator('[data-testid="debug-chat-line"]').nth(3);
    await line.scrollIntoViewIfNeeded();
    const lb = await line.boundingBox();
    const cb = await page.locator("[data-debug-chat]").boundingBox();
    check(!!lb && !!cb, `${name}: the chat and its line are on screen`);
    const drag = async (to) => {
      await page.mouse.move(lb.x + 6, lb.y + lb.height / 2);
      await page.mouse.down();
      const steps = 12;
      for (let k = 1; k <= steps; k++)
        await page.mouse.move(
          lb.x + 6 + ((to.x - lb.x - 6) * k) / steps,
          lb.y + lb.height / 2 + ((to.y - lb.y - lb.height / 2) * k) / steps,
        );
      const mid = await where(page);
      await page.mouse.up();
      await page.waitForTimeout(150);
      return { mid, end: await where(page) };
    };

    // The history is click-through at rest (log-engage.ts): a press-and-hold
    // engages it, then a click collapses the line it selected.
    await page.mouse.move(lb.x + 6, lb.y + lb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(750);
    await page.mouse.up();
    await page.mouse.click(lb.x + 6, lb.y + lb.height / 2);
    await page.waitForTimeout(200);

    // Out over the top of the chat, onto the page text (far left, near the top).
    const up = await drag({ x: 20, y: Math.max(10, cb.y - 200) });
    check(up.mid.fenced, `${name}: during the drag the page is fenced off`);
    check(!up.end.collapsed, `${name}: a drag up and out still selects chat text (${up.end.len})`);
    check(up.end.anchor && up.end.focus, `${name}: drag up — both ends stay in the chat`);
    check(!up.end.page, `${name}: drag up — no page text selected`);
    check(up.end.fenced, `${name}: the selection in the chat keeps the fence up`);

    // Out below the chat / to the far bottom-left.
    const down = await drag({ x: 20, y: 790 });
    check(down.end.anchor && down.end.focus, `${name}: drag down — both ends stay in the chat`);
    check(!down.end.page, `${name}: drag down — no page text selected`);

    // A handle-like move (iOS's handles): the focus set into the page by
    // script. Chromium takes it there and the clamp puts it back; WebKit
    // keeps the DOM focus but, the page being non-selectable, selects none
    // of it. Either way no page text is in the selection.
    await page.evaluate(async () => {
      const s = getSelection();
      const p = document.querySelector(".lk-qa-page");
      try {
        s.extend(p.firstChild, 10);
      } catch {
        s.setBaseAndExtent(s.anchorNode, s.anchorOffset, p.firstChild, 10);
      }
      await new Promise((r) => setTimeout(r, 100));
    });
    const back = await where(page);
    check(
      back.anchor && !back.page && (name === "webkit" || back.focus),
      `${name}: a focus moved into the page selects none of it ${JSON.stringify(back)}`,
    );

    // A press on the page drops the fence; the page's own drag selects page text.
    // A point on the page's text, clear of the chat.
    const at = await page.evaluate(() => {
      for (let y = 12; y < 780; y += 24)
        for (const x of [10, 40]) {
          const e = document.elementFromPoint(x, y);
          if (e?.classList.contains("lk-qa-page")) return { x, y };
        }
      return null;
    });
    check(!!at, `${name}: there is page text clear of the chat`);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 300, at.y + 48, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const own = await where(page);
    check(!own.fenced, `${name}: a press on the page drops the fence`);
    check(own.page && !own.anchor, `${name}: the page's own drag selects page text`);
    check(!errs.length, `${name}: no page errors ${errs.join("; ")}`);
    await browser.close();
  }
} finally {
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall select-fence checks passed");
