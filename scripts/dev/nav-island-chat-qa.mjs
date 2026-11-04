#!/usr/bin/env bun
/**
 * The bottom island never moves when the chat bar changes state
 * (docs/bottom-nav.md, "Sharing the bottom edge with the chat bar"). On the
 * widget server's /harness, with a stand-in island running the real reserve
 * and dock hooks (nav-island-fixture.tsx), at 412×915 (Android) and 390×844
 * (iPhone), from the bar's default place and from a saved place dragged down
 * over the island: the island's rect is the same expanded, minimized,
 * expanded again, and with a four-line draft. A drag of the bar onto the
 * island docks it once (no oscillation), and a drag away undocks it.
 *
 * Muted (silent.mjs); getUserMedia is stubbed, so nothing is recorded.
 *
 *   bun scripts/dev/nav-island-chat-qa.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const out = mkdtempSync(join(tmpdir(), "nav-island-qa-"));
const built = spawnSync(
  "bun",
  [
    "build",
    "scripts/dev/nav-island-fixture.tsx",
    "--target",
    "browser",
    "--outfile",
    join(out, "island.js"),
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(1);
const islandJs = readFileSync(join(out, "island.js"), "utf8");

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
const settle = (page) => page.waitForTimeout(500);
const rect = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("[data-nav-island] nav").getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
  });
/** Minimize with the mark; restore with the pill's Li (on the pill the mark tucks, fold.ts). */
const toggle = async (page) => {
  const min = await page.locator("[data-debug-chat][data-minimized]").count();
  await page.click(`[data-testid="${min ? "debug-chat-restore" : "debug-chat-pill-min"}"]`);
  await settle(page);
};

const browser = await launchSilent(chromium);
try {
  for (const [w, h, name] of [
    [412, 915, "Android 412×915"],
    [390, 844, "iPhone 390×844"],
  ]) {
    // pos: the bar's saved offset; null = its default place above the reserve.
    for (const pos of [null, { x: 0, y: 70 }]) {
      const where = pos ? "saved over the island" : "default place";
      const ctx = await newSilentContext(browser, {
        viewport: { width: w, height: h },
        deviceScaleFactor: 2,
        hasTouch: false,
      });
      await ctx.addInitScript(
        ([src, p]) => {
          localStorage.setItem("lk:debug-widget-src", src);
          if (p) localStorage.setItem("lk:debug-chat-pos", JSON.stringify(p));
          if (navigator.mediaDevices)
            navigator.mediaDevices.getUserMedia = async () => {
              throw new DOMException("refused in QA", "NotAllowedError");
            };
        },
        [`${ORIGIN}/debug-chat.js`, pos],
      );
      // The island first, as in the app: the bar then rests above its reserve.
      await ctx.addInitScript(
        (js) => document.addEventListener("DOMContentLoaded", () => new Function(js)()),
        islandJs,
      );
      const page = await ctx.newPage();
      await page.goto(`${ORIGIN}/harness?open`);
      await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
      await page.waitForSelector("[data-nav-island] nav");
      await settle(page);
      const seen = [["open", await rect(page)]];
      await toggle(page);
      seen.push(["minimized", await rect(page)]);
      await toggle(page);
      seen.push(["open again", await rect(page)]);
      await page.fill('[data-testid="debug-chat-input"]', "one\ntwo\nthree\nfour");
      await settle(page);
      seen.push(["typing 4 lines", await rect(page)]);
      await page.fill('[data-testid="debug-chat-input"]', "");
      await page.locator('[data-testid="debug-chat-input"]').blur();
      await toggle(page);
      seen.push(["minimized again", await rect(page)]);
      const same = seen.every(([, r]) => r === seen[0][1]);
      check(
        same,
        `${name}, ${where}: island unchanged — ${seen.map((s) => s.join(" ")).join(" · ")}`,
      );

      if (!pos) {
        // A drag of the minimized bar down onto the island docks it, once.
        const before = await rect(page);
        const bar = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
        const isl = await page.locator("[data-nav-island] nav").boundingBox();
        const sx = bar.x + 6;
        const sy = bar.y + bar.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx - 10, sy + 10, { steps: 3 });
        await page.mouse.move(sx - 10, isl.y + isl.height / 2, { steps: 8 });
        await page.mouse.up();
        await settle(page);
        const docked = await rect(page);
        const b = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
        const n = await page.locator("[data-nav-island] nav").boundingBox();
        check(
          docked !== before && n.y + n.height <= b.y,
          `${name}: a drag onto the island docks it above the bar (${before} → ${docked})`,
        );
        const r1 = await rect(page);
        await toggle(page);
        const r2 = await rect(page);
        await toggle(page);
        const r3 = await rect(page);
        await page.fill('[data-testid="debug-chat-input"]', "one\ntwo\nthree\nfour");
        await settle(page);
        const r4 = await rect(page);
        await page.fill('[data-testid="debug-chat-input"]', "");
        await page.locator('[data-testid="debug-chat-input"]').blur();
        await toggle(page);
        check(
          r1 === r2 && r2 === r3 && r3 === r4,
          `${name}: docked, toggling and typing keep it (${r1} · ${r2} · ${r3} · ${r4})`,
        );
        // Back up, away from the island: it returns home.
        const m = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
        await page.mouse.move(m.x + 6, m.y + m.height / 2);
        await page.mouse.down();
        await page.mouse.move(m.x + 6, m.y - 10, { steps: 3 });
        await page.mouse.move(m.x + 6, 200, { steps: 8 });
        await page.mouse.up();
        await settle(page);
        check(
          (await rect(page)) === before,
          `${name}: a drag away undocks it (${await rect(page)})`,
        );
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");
