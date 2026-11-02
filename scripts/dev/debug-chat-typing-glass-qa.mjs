#!/usr/bin/env node
/**
 * Browser checks for the chat's typing glass (packages/debug-chat/src/typing-glass.ts)
 * on the local /harness page, with the hot widget, over a made-up busy page:
 *
 *   - at rest the glass is hidden (not painted, not hit)
 *   - focusing the input frosts the page: blur + saturate, an oklch tint
 *   - a tap on the frosted page blurs the input and never reaches the page
 *   - the glass fades out again; nothing on the page moves (no layout shift)
 *   - under prefers-reduced-motion it does not animate
 *
 * getUserMedia is stubbed (refused): nothing is recorded. Browsers are muted
 * (scripts/qa/silent.mjs).
 *
 *   node scripts/dev/debug-chat-typing-glass-qa.mjs [--shots <dir>]
 *     --shots: save light/dark × resting/typing at 390×844 (iPhone) there
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

const browser = await launchSilent(chromium);
const open = async ({ colorScheme = "light", reducedMotion = "no-preference" } = {}) => {
  const ctx = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme,
    reducedMotion,
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
  // A busy page behind the chat: a word list with a button the glass must shield.
  await page.evaluate(() => {
    const words = ["serendipity", "ephemeral", "luminous", "quintessential", "resilience"];
    const list = document.createElement("main");
    list.id = "qa-page";
    list.style.cssText =
      "position:absolute;inset:0;padding:calc(1rem + env(safe-area-inset-top)) 1rem;font:20px/1.5 system-ui;";
    list.innerHTML =
      `<button id="qa-btn" style="font-size:18px;padding:.5rem 1rem;background:oklch(0.62 0.15 250);color:white;border:0;border-radius:.5rem">Page button</button>` +
      Array.from(
        { length: 14 },
        (_, i) =>
          `<p style="margin:.4rem 0;padding:.5rem;border-radius:.5rem;background:oklch(${i % 2 ? "0.85 0.08 150" : "0.8 0.1 30"} / 0.6)"><b>${words[i % 5]}</b> — a word on the page, row ${i + 1}</p>`,
      ).join("");
    document.body.prepend(list);
    globalThis.__btnClicks = 0;
    document.getElementById("qa-btn").addEventListener("click", () => globalThis.__btnClicks++);
  });
  await page.evaluate(() =>
    globalThis.__push("好的，打字的时候背景会变成磨砂玻璃，点一下背景就收起。", "agent"),
  );
  await page.waitForTimeout(400);
  return { ctx, page };
};
const glass = (page) =>
  page.evaluate(() => {
    const g = document.querySelector('[data-testid="debug-chat-typing-glass"]');
    if (!g) return null;
    const cs = getComputedStyle(g);
    return {
      shown: g.dataset.shown === "true",
      opacity: Number(cs.opacity),
      visibility: cs.visibility,
      filter: cs.backdropFilter || cs.webkitBackdropFilter,
      background: g.style.background,
      transition: cs.transitionProperty + " " + cs.transitionDuration,
      z: Number(cs.zIndex),
      chatZ: Number(getComputedStyle(document.querySelector("[data-debug-chat]")).zIndex),
    };
  });
const pageRect = (page) =>
  page.evaluate(() => {
    const r = document.getElementById("qa-btn").getBoundingClientRect();
    return `${r.x},${r.y},${r.width},${r.height},${document.documentElement.scrollWidth}`;
  });

try {
  for (const scheme of ["light", "dark"]) {
    const { ctx, page } = await open({ colorScheme: scheme });
    const rest = await glass(page);
    check(!!rest, `${scheme}: the glass is mounted`);
    check(rest.visibility === "hidden" && rest.opacity === 0, `${scheme}: hidden at rest`);
    const before = await pageRect(page);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `typing-glass-rest-${scheme}.png`) });
    }
    // The page button is clickable at rest.
    await page.click("#qa-btn");
    check(
      (await page.evaluate(() => globalThis.__btnClicks)) === 1,
      `${scheme}: page usable at rest`,
    );

    await page.locator('[data-testid="debug-chat-input"]').focus();
    await page.waitForTimeout(250);
    const on = await glass(page);
    check(
      on.shown && on.visibility === "visible" && on.opacity === 1,
      `${scheme}: up while typing`,
    );
    check(
      /blur\(12px\)/.test(on.filter) && /saturate\(1\.4\)/.test(on.filter),
      `${scheme}: blur + saturate`,
    );
    check(
      /oklch\(/.test(on.background) && !/rgb|#/.test(on.background),
      `${scheme}: an oklch tint`,
    );
    check(/150ms|0\.15s/.test(on.transition), `${scheme}: ~150 ms fade`);
    check(on.z < on.chatZ, `${scheme}: under the chat, over the page`);
    check((await pageRect(page)) === before, `${scheme}: no layout shift`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `typing-glass-${scheme}.png`) });

    // A tap on the frosted page button: blurs the input, never clicks the page.
    const box = await page.locator("#qa-btn").boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    check(
      (await page.evaluate(() => globalThis.__btnClicks)) === 1,
      `${scheme}: a tap on the glass does not reach the page`,
    );
    check(
      await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") !== "debug-chat-input",
      ),
      `${scheme}: a tap on the glass blurs the input`,
    );
    const off = await glass(page);
    check(off.visibility === "hidden" && off.opacity === 0, `${scheme}: gone after the fade`);
    await page.click("#qa-btn");
    check(
      (await page.evaluate(() => globalThis.__btnClicks)) === 2,
      `${scheme}: page usable again after`,
    );
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ reducedMotion: "reduce" });
    await page.locator('[data-testid="debug-chat-input"]').focus();
    await page.waitForTimeout(50);
    const g = await glass(page);
    check(g.shown && /^all 0s|none|0s/.test(g.transition), "reduced motion: no fade");
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
console.log("\nall typing-glass checks passed");
