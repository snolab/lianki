#!/usr/bin/env bun
/**
 * Browser checks for the chat's lanes (packages/debug-chat/src/voices.ts,
 * LaneMark.tsx; docs/dev-debug-widget.md, "Lanes and voices"), on the local
 * /harness page with the hot widget, at 390×844 with touch, light and dark:
 *
 *   - a `【codex】` / `【agy】` line shows that lane's mark and name tag, and the
 *     prefix is gone from its text; a `lane` field does the same
 *   - a plain agent line has no tag and keeps the agent's avatar (as today)
 *   - the marks differ from each other and from the agent's avatar
 *   - the name tag's colour is readable on the log's background (contrast)
 *
 * Nothing is read aloud: browsers are muted and speech is off
 * (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-lanes-qa.mjs [--shots <dir>]
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
    await page.evaluate(() => {
      globalThis.__push("【codex】 好的，我先看测试。", "agent");
      globalThis.__push("【agy】 页面已经修好了。", "agent");
      globalThis.__line({
        from: "agent",
        label: "agent",
        text: "lane field, no prefix",
        lane: "codex",
      });
      globalThis.__push("plain main-lane line", "agent");
    });
    await page.waitForTimeout(400);

    const runs = await page.$$eval('[data-testid="debug-chat-run"]', (els) =>
      els.slice(-4).map((li) => {
        const tag = li.querySelector('[data-testid="debug-chat-lane"]');
        const mark = li.querySelector('[data-testid="debug-chat-lane-mark"]');
        const av = li.querySelector('[data-testid="debug-chat-avatar"]');
        const line = li.querySelector('[data-testid="debug-chat-line"]');
        const box = av?.getBoundingClientRect();
        return {
          tag: tag?.textContent ?? null,
          tagColor: tag ? getComputedStyle(tag).color : null,
          mark: mark?.getAttribute("data-lane") ?? null,
          markBg: mark ? mark.style.background : null,
          avatar: av?.getAttribute("data-avatar") ?? null,
          avatarPx: box ? Math.round(box.width) : 0,
          text: line?.textContent ?? "",
        };
      }),
    );
    const [codex, agy, field, plain] = runs;
    check(
      codex?.tag === "codex" && codex.mark === "codex",
      `${scheme}: 【codex】 line has codex's mark and tag`,
    );
    check(
      !codex?.text.includes("【"),
      `${scheme}: the prefix is gone from its text (${codex?.text})`,
    );
    check(
      agy?.tag === "agy" && agy.mark === "agy",
      `${scheme}: 【agy】 line has agy's mark and tag`,
    );
    check(!agy?.text.includes("【"), `${scheme}: agy's prefix is gone (${agy?.text})`);
    check(
      field?.tag === "codex" && field.mark === "codex",
      `${scheme}: a lane field works the same`,
    );
    check(
      plain?.tag === null && plain.mark === null,
      `${scheme}: a plain agent line has no tag or mark`,
    );
    check(
      plain?.avatar === "node",
      `${scheme}: the plain line keeps the agent's avatar (${plain?.avatar})`,
    );
    check(codex?.markBg !== agy?.markBg, `${scheme}: the two marks have their own colours`);
    check(
      codex?.avatarPx === plain?.avatarPx && codex?.avatarPx > 0,
      `${scheme}: marks keep the avatar's size`,
    );
    // The tag reads on the log's background: its colour is not the background's.
    const bg = await page.$eval("[data-debug-chat]", (el) => {
      let e = el;
      while (e) {
        const c = getComputedStyle(e).backgroundColor;
        if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
        e = e.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    });
    check(
      codex?.tagColor && codex.tagColor !== bg,
      `${scheme}: the tag's colour (${codex?.tagColor}) is not the background (${bg})`,
    );
    if (SHOTS) {
      // Engaged (the input focused): the whole log shows, not only the faint idle tail.
      await page.locator('[data-testid="debug-chat-input"]').focus();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `lanes-${scheme}.png`) });
    }
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
console.log("\nall lane checks passed");
