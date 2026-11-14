#!/usr/bin/env bun
/** Actual-widget regression: dock resize, focus, persistence, viewport clamp,
 * cancellation and the floating/narrow-screen gates. Browsers are silent. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
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

const SECTION = "[data-debug-widget] section[data-debug-chat]";
const HANDLE = '[data-testid="debug-chat-dock-resize"]';
const INPUT = '[data-testid="debug-chat-input"]';
async function run(engine, name, viewport, scheme) {
  const browser = await launchSilent(engine);
  const ctx = await newSilentContext(browser, { viewport, hasTouch: true, colorScheme: scheme });
  try {
    await ctx.addInitScript((src) => {
      localStorage.setItem("lk:debug-widget-src", src);
      localStorage.setItem(
        "lk:pref:chat-view",
        JSON.stringify({ version: 1, state: { full: true, compact: false, etaFolded: false } }),
      );
    }, `${ORIGIN}/debug-chat.js`);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree&full`);
    await page.locator(`${SECTION}[data-fullscreen]`).waitFor();
    await page.locator(HANDLE).waitFor();
    const width = () => page.locator(SECTION).evaluate((el) => el.getBoundingClientRect().width);
    const stored = () =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("lk:pref:chat-dock") || "null")?.state.width ?? null,
      );
    await page.locator(INPUT).fill("draft stays");
    await page.locator(INPUT).focus();
    const original = await width();
    await page.locator(HANDLE).tap();
    assert.equal(await stored(), null, "a border tap does not persist a fixed width");
    assert.equal(
      await page.locator(INPUT).evaluate((el) => el === document.activeElement),
      true,
      "touch border tap keeps input focus",
    );
    let b = await page.locator(HANDLE).boundingBox();
    const x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    assert.equal(
      await page.locator(INPUT).evaluate((el) => el === document.activeElement),
      true,
      "border press keeps input focus",
    );
    await page.mouse.move(x - 80, y, { steps: 8 });
    assert.ok(Math.abs((await width()) - (original + 80)) < 2, "left edge widens by delta");
    assert.equal(await stored(), null, "preview does not persist before release");
    await page.mouse.up();
    const saved = await stored();
    assert.ok(Math.abs(saved - (original + 80)) < 2);
    const reserve = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).paddingRight),
    );
    assert.ok(Math.abs(reserve - (await width())) < 2, "page reserve follows actual width");
    assert.equal(await page.locator(INPUT).inputValue(), "draft stays");
    assert.equal(
      await page.locator(INPUT).evaluate((el) => el === document.activeElement),
      true,
      "release keeps input focus",
    );
    // A real pointer drag cancelled by the browser restores the remembered width.
    b = await page.locator(HANDLE).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 50, b.y + b.height / 2, { steps: 4 });
    await page.locator(HANDLE).dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true });
    await page.mouse.up();
    assert.ok(Math.abs((await width()) - saved) < 2, "cancel restores saved width");
    assert.equal(await stored(), saved);
    if (name === "chromium") {
      const cdp = await ctx.newCDPSession(page);
      b = await page.locator(HANDLE).boundingBox();
      const tx = b.x + b.width / 2,
        ty = b.y + b.height / 2;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: tx, y: ty }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: tx - 30, y: ty }],
      });
      assert.ok(Math.abs((await width()) - (saved + 30)) < 2, "real touch pointer resizes");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      assert.ok(Math.abs((await width()) - saved) < 2, "touch cancel restores saved size");
      assert.equal(await stored(), saved);
      await cdp.detach();
    }
    await page.reload();
    await page.locator(HANDLE).waitFor();
    assert.ok(Math.abs((await width()) - saved) < 2, "width survives reload");
    await page.locator(HANDLE).focus();
    await page.keyboard.press("Home");
    assert.ok(Math.abs((await width()) - 320) < 2, "Home clamps to composer minimum");
    await page.keyboard.press("ArrowLeft");
    assert.ok(Math.abs((await width()) - 330) < 2, "keyboard grows width");
    await page.keyboard.press("End");
    assert.ok(Math.abs((await width()) - viewport.width) < 2, "End clamps to viewport");
    const safeHandle = await page.locator(HANDLE).boundingBox();
    assert.ok(safeHandle.x >= 24, "full-width handle stays outside system back strip");
    // A keyboard/pan-reduced visual viewport clamps display, not the preference.
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "width", { configurable: true, value: 500 });
      Object.defineProperty(visualViewport, "offsetLeft", { configurable: true, value: 30 });
      dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(50);
    assert.ok(Math.abs((await width()) - 500) < 2, "clamped to visual viewport");
    const panned = await page.locator(SECTION).boundingBox();
    assert.ok(Math.abs(panned.x - 30) < 2, "sidebar follows viewport pan");
    assert.equal(
      await stored(),
      viewport.width,
      "temporary clamp does not overwrite desired width",
    );
    await page.evaluate(() => {
      delete visualViewport.width;
      delete visualViewport.offsetLeft;
      dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(50);
    assert.ok(
      Math.abs((await width()) - viewport.width) < 2,
      "larger viewport restores desired width",
    );
    // Narrow full-screen has no resize affordance and keeps remembered width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="debug-chat-dock-resize"]'),
    );
    assert.ok(Math.abs((await width()) - 390) < 2, "narrow full-screen still spans phone");
    assert.equal(await stored(), viewport.width);
    // Floats never resize, even when the device remembers a dock width.
    await page.locator('[data-testid="debug-chat-fullscreen-exit"]').click();
    assert.equal(await page.locator(HANDLE).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${name} ${scheme} ${viewport.width}x${viewport.height}: border focus, width, reserve, cancel, reload, keys, phone gate, floating gate`,
    );
  } finally {
    await ctx.close();
    await browser.close();
  }
}
try {
  for (const [engine, name] of [
    [chromium, "chromium"],
    [webkit, "webkit"],
  ])
    for (const scheme of ["light", "dark"])
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 740, height: 390 },
      ])
        await run(engine, name, viewport, scheme);
} finally {
  server.kill();
}
