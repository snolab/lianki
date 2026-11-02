#!/usr/bin/env node
/**
 * Browser checks for the chat's compact mode (packages/debug-chat/src/compact-view.ts)
 * on the local /harness page, with the hot widget (its Tailwind CSS too):
 *
 *   - off by default: the open chat shows its log as before
 *   - on (lk:pref:chat-view), the input unfocused: only the last message,
 *     with its avatar and no visible name; the bar, the input and the mic
 *     stay (the mic's slot and the input are not inert)
 *   - a new message replaces the line
 *   - an open ask card shows in full, its pills tappable
 *   - a tap on the line shows the whole chat; it folds again after the hold
 *   - focusing the input shows the whole chat; a blur folds it after the hold
 *
 * getUserMedia is stubbed (refused): nothing is recorded. Browsers are muted
 * (scripts/qa/silent.mjs).
 *
 *   node scripts/dev/debug-chat-compact-qa.mjs [--shots <dir>]
 *     --shots: save light/dark × compact/expanded at 390×844 (iPhone) there
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
const open = async ({ compact, colorScheme = "light" }) => {
  const ctx = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme,
    hasTouch: false,
  });
  await ctx.addInitScript(
    ([src, on]) => {
      localStorage.setItem("lk:debug-widget-src", src);
      if (on)
        localStorage.setItem(
          "lk:pref:chat-view",
          JSON.stringify({ state: { compact: true }, version: 1 }),
        );
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException("refused in QA", "NotAllowedError");
        };
    },
    [`${ORIGIN}/debug-chat.js`, compact],
  );
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/harness?open&nofrontier`);
  await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
  await page.waitForTimeout(400);
  return { ctx, page };
};
const q = (page, id) => page.locator(`[data-testid="${id}"]`);
const visible = (page, id) =>
  q(page, id)
    .first()
    .isVisible()
    .catch(() => false);

try {
  // Off by default.
  {
    const { ctx, page } = await open({ compact: false });
    check(await visible(page, "debug-chat-column"), "off: the log shows as before");
    check((await q(page, "debug-chat-compact").count()) === 0, "off: no compact view");
    await ctx.close();
  }
  for (const scheme of ["light", "dark"]) {
    const { ctx, page } = await open({ compact: true, colorScheme: scheme });
    await page.evaluate(() =>
      globalThis.__push("好的，我先把紧凑模式做成每台设备单独的设置，默认关闭。", "agent"),
    );
    await page.waitForTimeout(200);
    check(!(await visible(page, "debug-chat-column")), `${scheme}: compact hides the log`);
    check((await q(page, "debug-chat-compact-line").count()) === 1, `${scheme}: one compact line`);
    const line = await q(page, "debug-chat-compact-line").innerText();
    check(line.includes("紧凑模式"), `${scheme}: the line is the last message`);
    check(
      (await q(page, "debug-chat-compact-line")
        .locator("img, [role=img], span[aria-hidden]")
        .count()) > 0,
      `${scheme}: the line has an avatar`,
    );
    const bar = await page.evaluate(() => {
      const slot = document.querySelector('[data-testid="debug-chat-input-slot"]');
      const mic = document.querySelector('[data-testid="debug-chat-mic"]');
      return { inert: slot?.inert ?? true, mic: !!mic && mic.getClientRects().length > 0 };
    });
    check(!bar.inert && bar.mic, `${scheme}: input and mic stay usable`);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `compact-${scheme}.png`) });
    }
    // A tap on the line: the whole chat.
    await q(page, "debug-chat-compact-line").click();
    await page.waitForTimeout(250);
    check(
      await visible(page, "debug-chat-column"),
      `${scheme}: a tap on the line shows the whole chat`,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `expanded-${scheme}.png`) });
    // The input: focus keeps it whole, the blur folds it after the hold.
    await q(page, "debug-chat-input").focus();
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(600);
    check(await visible(page, "debug-chat-column"), `${scheme}: not folded right after the blur`);
    await page.waitForTimeout(9000); // past the tap's 8 s hold too
    check(
      (await q(page, "debug-chat-compact-line").count()) === 1,
      `${scheme}: folded after the hold`,
    );
    // A new message replaces the line.
    await page.evaluate(() => globalThis.__push("第二条：已经推送预览。", "agent"));
    await page.waitForTimeout(200);
    check(
      (await q(page, "debug-chat-compact-line").innerText()).includes("第二条"),
      `${scheme}: a new message updates the line`,
    );
    // An open ask card shows in full, even under a later line.
    await page.evaluate(() =>
      globalThis.__ask({
        askId: `qa-${Date.now()}`,
        questions: [
          {
            id: "q",
            question: "开启紧凑模式？",
            options: [
              { id: "y", label: "开启", recommended: true },
              { id: "n", label: "先不" },
            ],
          },
        ],
      }),
    );
    await page.evaluate(() => globalThis.__push("等你点一下。", "agent"));
    await page.waitForTimeout(200);
    check(
      (await q(page, "debug-chat-compact-ask").count()) === 1,
      `${scheme}: an open ask stays in full`,
    );
    check(
      (await q(page, "debug-chat-compact-ask").locator("button").count()) >= 2,
      `${scheme}: its pills are there`,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `compact-ask-${scheme}.png`) });
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
console.log("\nall compact checks passed");
