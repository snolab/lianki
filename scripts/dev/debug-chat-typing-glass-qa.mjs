#!/usr/bin/env node
/**
 * Browser checks for the chat's typing glass (packages/debug-chat/src/typing-glass.ts)
 * on the local /harness page, with the hot widget, over a made-up busy page:
 *
 *   - at rest the glass is hidden (not painted)
 *   - focusing the input frosts the chat box's own area only: blur + saturate,
 *     an oklch tint, inside the box (owner, 2026-11-03: not full-screen)
 *   - the page outside the box stays sharp and usable: a tap on a page button
 *     while typing reaches the page (nothing catches taps)
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
  // A busy page behind the chat: a word list, with a button that must stay usable.
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
    globalThis.__push(
      "好的，打字的时候只有聊天框这一块变成磨砂玻璃，页面其他地方保持清晰。",
      "agent",
    ),
  );
  await page.waitForTimeout(400);
  return { ctx, page };
};
const glass = (page) =>
  page.evaluate(() => {
    const g = document.querySelector('[data-testid="debug-chat-typing-glass"]');
    if (!g) return null;
    const cs = getComputedStyle(g);
    const chat = document.querySelector("[data-debug-chat]");
    const r = g.getBoundingClientRect();
    const c = chat.getBoundingClientRect();
    return {
      inChat: chat.contains(g),
      // Its rect: the box's, a few px past its edge; nowhere near the screen's.
      rect: { w: r.width, h: r.height, dw: r.width - c.width, dh: r.height - c.height },
      screen: { w: innerWidth, h: innerHeight },
      pointer: cs.pointerEvents,
      // Owner, 2026-11-03: "包括输入框和显示的消息" — the input and the shown messages.
      covers: ["debug-chat-input", "debug-chat-column"].every((id) => {
        const e = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        return (
          !!e &&
          e.height > 0 &&
          e.left >= r.left &&
          e.right <= r.right &&
          e.top >= r.top &&
          e.bottom <= r.bottom
        );
      }),
      shown: g.dataset.shown === "true",
      opacity: Number(cs.opacity),
      visibility: cs.visibility,
      filter: cs.backdropFilter || cs.webkitBackdropFilter,
      background: g.style.background,
      transition: cs.transitionProperty + " " + cs.transitionDuration,
      z: Number(cs.zIndex),
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
    check(on.inChat && on.z < 0, `${scheme}: inside the chat box, behind its content`);
    check(
      on.rect.dw > 0 &&
        on.rect.dw <= 16 &&
        on.rect.dh > 0 &&
        on.rect.dh <= 16 &&
        on.rect.w < on.screen.w &&
        on.rect.h < on.screen.h / 2,
      `${scheme}: only the box's own area (${Math.round(on.rect.w)}×${Math.round(on.rect.h)} of ${on.screen.w}×${on.screen.h})`,
    );
    check(on.covers, `${scheme}: covers the input and the shown messages`);
    check(on.pointer === "none", `${scheme}: takes no pointer`);
    check(
      (await page.locator('[data-testid="debug-chat-typing-glass"][data-shown]').count()) === 1 &&
        (await page.evaluate(
          () =>
            [...document.querySelectorAll("body *")].filter((el) => {
              if (el.closest("[data-debug-chat]")) return false;
              const f = getComputedStyle(el).backdropFilter;
              const r = el.getBoundingClientRect();
              return f && f !== "none" && r.width >= innerWidth && r.height >= innerHeight;
            }).length,
        )) === 0,
      `${scheme}: no full-screen blur layer`,
    );
    check((await pageRect(page)) === before, `${scheme}: no layout shift`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `typing-glass-${scheme}.png`) });

    // The page around the box stays usable while typing: a tap reaches it.
    const box = await page.locator("#qa-btn").boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    check(
      (await page.evaluate(() => globalThis.__btnClicks)) === 2,
      `${scheme}: a tap on the page while typing reaches the page`,
    );
    // Tapping the page blurs the input (a button takes the focus): the glass goes.
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(300);
    const off = await glass(page);
    check(off.visibility === "hidden" && off.opacity === 0, `${scheme}: gone after the fade`);
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
