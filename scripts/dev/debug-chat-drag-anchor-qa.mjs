#!/usr/bin/env bun
/** Two-view actual-widget regression: a held grip survives async full→float layout. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";
const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const origin = `http://localhost:${port}`;
const server = spawn(
  "bun",
  ["scripts/dev/debug-widget-server.ts", "--port", String(port), "--no-tunnel"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const failures = [];
const check = (ok, label, evidence) => {
  console.log(`${ok ? "ok" : "FAIL"} ${label} ${JSON.stringify(evidence ?? {})}`);
  if (!ok) failures.push(label);
};
const SECTION = "[data-debug-widget] section[data-debug-chat]";
const GRIP = '[data-testid="debug-chat-pill-min"]';
const KEYS = ["lk:debug-chat-pos", "lk:pref:chat-view", "lk:pref:chat-dock"];
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("harness startup timeout")), 60_000);
    server.stdout.on("data", (data) => {
      if (String(data).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}`));
    });
  });
  browser = await launchSilent(chromium);
  for (const viewport of [
    { width: 1680, height: 855 },
    { width: 433, height: 855 },
  ]) {
    for (const mode of ["screen", "side"]) {
      const tag = `${viewport.width}x${viewport.height}/${mode}`;
      const context = await newSilentContext(browser, {
        viewport,
        hasTouch: viewport.width < 500,
        isMobile: viewport.width < 500,
      });
      try {
        await context.addInitScript(
          ({ src, mode }) => {
            localStorage.setItem("lk:debug-widget-src", src);
            localStorage.setItem(
              "lk:pref:chat-view",
              JSON.stringify({
                version: 1,
                state: { full: true, fullMode: mode, compact: false, etaFolded: false },
              }),
            );
            if (navigator.mediaDevices)
              navigator.mediaDevices.getUserMedia = async () => {
                throw new DOMException("QA", "NotAllowedError");
              };
            const original = Storage.prototype.setItem;
            globalThis.__anchorWrites = [];
            Storage.prototype.setItem = function (key, value) {
              if (
                globalThis.__anchorRecording &&
                ["lk:debug-chat-pos", "lk:pref:chat-view", "lk:pref:chat-dock"].includes(key)
              )
                globalThis.__anchorWrites.push({ key, value });
              return original.call(this, key, value);
            };
          },
          { src: `${origin}/debug-chat.js`, mode },
        );
        const page = await context.newPage();
        await page.route("**/*", (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await page.goto(`${origin}/harness?open&nofrontier&notree&full`);
        await page.locator(`${SECTION}[data-fullscreen]`).waitFor();
        // The public store's optional fullMode is not part of the older stored
        // shape; use the same live store action as the snap-zone handler.
        await page.evaluate((mode) => {
          globalThis.__lkUiStores.get("lk:pref:chat-view").setState({ full: true, fullMode: mode });
        }, mode);
        const frames = () =>
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        await frames();
        await page.waitForTimeout(350);
        const state = () =>
          page.evaluate(
            ({ section, grip, keys }) => {
              const rect = (selector) => {
                const r = document.querySelector(selector).getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              };
              return {
                full: document.querySelector(section).hasAttribute("data-fullscreen"),
                box: rect(section),
                grip: rect(grip),
                stored: keys.map((k) => localStorage.getItem(k)),
              };
            },
            { section: SECTION, grip: GRIP, keys: KEYS },
          );
        const before = await state();
        check(
          mode === "screen"
            ? Math.abs(before.box.width - viewport.width) <= 1
            : before.box.width < viewport.width - 1,
          `${tag}: requested layout is actually rendered`,
          before.box,
        );
        await page.evaluate(() => {
          globalThis.__anchorRecording = true;
          globalThis.__anchorWrites.length = 0;
        });
        const grab = { x: before.grip.width / 2, y: before.grip.height / 2 };
        const start = { x: before.grip.x + grab.x, y: before.grip.y + grab.y };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        // One move across the threshold; mouse stays down while React commits.
        // At 433px, x=80 leaves room for the 320px floating panel on both sides.
        const targetX = viewport.width < 500 ? 80 : 840;
        const points = [
          { x: targetX, y: 470 },
          { x: targetX, y: 420 },
          { x: targetX, y: 370 },
        ];
        for (const [index, point] of points.entries()) {
          await page.mouse.move(point.x, point.y, { steps: index === 0 ? 1 : 20 });
          await frames();
          const at = await state();
          const error = { x: at.grip.x + grab.x - point.x, y: at.grip.y + grab.y - point.y };
          check(!at.full, `${tag} move ${index}: left full mode while held`, at);
          check(
            Math.abs(error.y) <= 2 && Math.abs(error.x) <= 2,
            `${tag} move ${index}: grab follows pointer`,
            { point, error, grip: at.grip },
          );
          check(
            at.box.x >= -2 && at.box.x + at.box.width <= viewport.width + 2,
            `${tag} move ${index}: horizontal viewport clamp`,
            at.box,
          );
        }
        await page.keyboard.press("Escape");
        await frames();
        await page.mouse.up();
        await frames();
        const after = await state();
        const sameRect = (a, b) =>
          ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) <= 1);
        check(
          after.full === before.full &&
            sameRect(after.box, before.box) &&
            sameRect(after.grip, before.grip),
          `${tag} Escape restores exact mode and geometry`,
          { before, after },
        );
        const writes = await page.evaluate(() => globalThis.__anchorWrites);
        check(
          JSON.stringify(after.stored) === JSON.stringify(before.stored) && writes.length === 0,
          `${tag} cancelled drag does not persist`,
          { writes, before: before.stored, after: after.stored },
        );
      } finally {
        await context.close();
      }
    }
  }
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  await browser?.close();
  server.kill();
}
console.log(`${failures.length} failed checks`);
process.exitCode = failures.length ? 1 : 0;
