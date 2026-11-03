#!/usr/bin/env node
/**
 * The chat bar's mic is concentric with the bar's corner
 * (packages/debug-chat/src/DebugChat.tsx, MicButton.tsx): the centre of the
 * mic's circle sits on the centre of the bar's bottom-right corner arc,
 * within 0.5 px, in every state the bar takes:
 *
 *   - expanded (one line), minimized, a draft of several lines (the bar grows
 *     and the mic stays in the bottom-right arc), the chat's text size at 150%
 *   - 390×844 and 412×915, light and dark
 *   - the bar's round controls are [mark | + | input | mic] expanded and
 *     [mark | mic] minimized (no tree button since 2026-11-03: the state tree
 *     is in the + menu), each centred on the mic's line (one line box high)
 *
 * The rule (R = d/2 + g, the nested-radius rule): the bar's radius is
 * --lk-bar-r = border + padding + line/2, and the mic's circle is the
 * line-sized square at the bar's inner bottom-right. One line high, the bar
 * is 2R tall, so the top-right arc shares the centre too (checked as well).
 *
 * The mic's circle is its content box (the button's padding leaves exactly
 * the circle's square at its end). The arc's radius is the computed one,
 * clamped the way browsers clamp it (to half the box).
 *
 * Same harness as debug-chat-bar-qa.mjs (the hot widget on /harness, no
 * lianki-push). Browsers muted (qa/silent.mjs); getUserMedia refused.
 *
 *   node scripts/dev/debug-chat-concentric-qa.mjs [--shots <dir>]
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
const MAX_DELTA = 0.5;

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

/** In the page: the bar's corner-arc centres and the mic circle's centre. */
const measure = () => {
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  const bar = q("debug-chat-pill");
  const mic = q("debug-chat-mic");
  if (!bar || !mic) return null;
  const b = bar.getBoundingClientRect();
  const cs = getComputedStyle(bar);
  const r = Math.min(Number.parseFloat(cs.borderBottomRightRadius), b.height / 2, b.width / 2);
  const m = mic.getBoundingClientRect();
  const ms = getComputedStyle(mic);
  const px = (v) => Number.parseFloat(v) || 0;
  const left = m.left + px(ms.borderLeftWidth) + px(ms.paddingLeft);
  const right = m.right - px(ms.borderRightWidth) - px(ms.paddingRight);
  const top = m.top + px(ms.borderTopWidth) + px(ms.paddingTop);
  const bottom = m.bottom - px(ms.borderBottomWidth) - px(ms.paddingBottom);
  const mc = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const arc = { x: b.right - r, y: b.bottom - r };
  const topArc = { x: b.right - r, y: b.top + r };
  // The round controls, left of the input and the mic: centred on the mic's line.
  const controls = [...bar.querySelectorAll("button")]
    .filter((el) => !el.closest("[inert]") && el.getBoundingClientRect().width > 0)
    .map((el) => el.dataset.testid);
  const lineOff = ["debug-chat-pill-min", "debug-chat-attach"]
    .map((id) => q(id))
    .filter(Boolean)
    .map((el) => {
      const c = el.getBoundingClientRect();
      return Math.abs((c.top + c.bottom) / 2 - mc.y);
    });
  return {
    controls,
    lineOff: Math.max(0, ...lineOff),
    r,
    h: b.height,
    d: Math.min(right - left, bottom - top),
    square: Math.abs(right - left - (bottom - top)),
    dx: mc.x - arc.x,
    dy: mc.y - arc.y,
    delta: Math.hypot(mc.x - arc.x, mc.y - arc.y),
    topDelta: Math.hypot(mc.x - topArc.x, mc.y - topArc.y),
  };
};

const browser = await launchSilent(chromium);
const results = [];
try {
  for (const [width, height] of [
    [390, 844],
    [412, 915],
  ])
    for (const scheme of ["light", "dark"]) {
      const ctx = await newSilentContext(browser, {
        viewport: { width, height },
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
      await page.goto(`${ORIGIN}/harness?open`);
      await page.waitForSelector('[data-testid="debug-chat-mic"]', { timeout: 30_000 });
      await page.waitForTimeout(400); // the width transition
      const at = `${width}×${height} ${scheme}`;
      const run = async (state) => {
        const m = await page.evaluate(measure);
        if (!m) return check(false, `${at} ${state}: bar and mic found`);
        results.push({ at, state, ...m });
        const f = (n) => n.toFixed(2);
        check(
          m.delta <= MAX_DELTA,
          `${at} ${state}: mic centre on the corner arc's centre (Δ ${f(m.delta)} px: dx ${f(m.dx)}, dy ${f(m.dy)}; R ${f(m.r)}, d ${f(m.d)}, bar ${f(m.h)} tall)`,
        );
        check(
          m.square <= 0.5,
          `${at} ${state}: the mic's circle is square (off by ${f(m.square)})`,
        );
        const want =
          state === "minimized"
            ? "debug-chat-pill-min,debug-chat-mic"
            : "debug-chat-pill-min,debug-chat-attach,debug-chat-mic";
        check(
          m.controls.join() === want,
          `${at} ${state}: the bar's controls are ${want} (${m.controls.join()})`,
        );
        check(
          m.lineOff <= MAX_DELTA,
          `${at} ${state}: the mark and the + are centred on the mic's line (off by ${f(m.lineOff)} px)`,
        );
        if (state === "one line" || state === "minimized")
          check(
            m.topDelta <= MAX_DELTA,
            `${at} ${state}: one line high, also on the top-right arc's centre (Δ ${f(m.topDelta)} px)`,
          );
        if (SHOTS && width === 390) {
          const slug = state.replaceAll(" ", "-").replaceAll("%", "");
          const bar = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
          await page.screenshot({ path: join(SHOTS, `concentric-${slug}-${scheme}.png`) });
          await page.screenshot({
            path: join(SHOTS, `concentric-${slug}-${scheme}-zoom.png`),
            clip: {
              x: Math.max(0, bar.x + bar.width - 120),
              y: Math.max(0, bar.y - 12),
              width: 132,
              height: bar.height + 24,
            },
          });
        }
      };
      await run("one line");
      const input = page.locator('[data-testid="debug-chat-input"]');
      await input.fill("one\ntwo\nthree\nfour");
      await input.dispatchEvent("input");
      await page.waitForTimeout(200);
      await run("four lines");
      await input.fill("");
      await page.evaluate(() => document.documentElement.style.setProperty("--lk-fs-chat", "1.5"));
      await page.waitForTimeout(200);
      await run("text 150%");
      await page.evaluate(() => document.documentElement.style.removeProperty("--lk-fs-chat"));
      await input.blur();
      // Minimize: a tap on the mark (single tap after its double-tap window).
      await page.click('[data-testid="debug-chat-pill-min"]');
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="debug-chat-pill-min"]')
            ?.getAttribute("aria-expanded") === "false",
        null,
        { timeout: 5000 },
      );
      await page.waitForTimeout(500);
      await run("minimized");
      await ctx.close();
    }
} finally {
  await browser.close();
  server.kill();
}

const worst = Math.max(...results.map((r) => r.delta));
console.log(`\nworst Δ ${worst.toFixed(2)} px over ${results.length} measurements`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all concentric checks passed");
