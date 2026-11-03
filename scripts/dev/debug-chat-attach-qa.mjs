#!/usr/bin/env node
/**
 * Browser checks for the chat input's + menu (packages/debug-chat/src/
 * AttachMenu.tsx; docs/dev-debug-widget.md, "The + menu") on the local
 * /harness page, at iPhone and Android sizes with touch:
 *
 *   - text selected on the page survives the tap on the chat input (a phone
 *     clears the selection then) and can be attached from +
 *   - the chip shows it; the line is sent with `context`; the log quotes it
 *   - × drops it: the next line goes without
 *   - a tap elsewhere on the page forgets the selection; a password field is
 *     never read
 *   - the Add group lists the host's items and runs them
 *
 * Silent (muted browser); getUserMedia refused.
 *
 *   node scripts/dev/debug-chat-attach-qa.mjs [--shots <dir>]
 *     --shots: light and dark, iPhone and Android, menu open and chip shown
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, devices } from "playwright";
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

const DEVICES = {
  iphone: devices["iPhone 13"],
  android: devices["Pixel 7"],
};
const TEXT = "Le chat noir dort sur le canapé depuis ce matin.";
const tid = (id) => `[data-testid="${id}"]`;

const browser = await launchSilent(chromium);
try {
  for (const [name, dev] of Object.entries(DEVICES)) {
    for (const colorScheme of ["light", "dark"]) {
      const ctx = await newSilentContext(browser, {
        viewport: dev.viewport,
        deviceScaleFactor: 2,
        userAgent: dev.userAgent,
        isMobile: true,
        hasTouch: true,
        colorScheme,
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
      await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
      await page.waitForTimeout(400);
      const at = `${name}/${colorScheme}:`;
      const selectText = () =>
        page.evaluate(() => {
          const p = document.querySelector('[data-testid="harness-text"]');
          const r = document.createRange();
          r.selectNodeContents(p);
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
        });
      const sentLast = () => page.evaluate(() => window.__sent?.at(-1) ?? null);

      // 1. Select on the page, tap the input (the selection collapses), attach from +.
      await selectText();
      await page.waitForTimeout(50);
      await page.tap(tid("debug-chat-input"));
      const collapsed = await page.evaluate(() => getSelection().toString() === "");
      await page.tap(tid("debug-chat-attach"));
      await page.waitForSelector(tid("debug-chat-attach-menu"));
      const item = page.locator(tid("debug-chat-attach-selection"));
      check(
        !(await item.isDisabled()) && (await item.textContent()).includes("Le chat noir"),
        `${at} the selection is offered after the input took focus (page selection collapsed: ${collapsed})`,
      );
      const soon = await page.locator(`${tid("debug-chat-attach-file")}[disabled]`).count();
      check(soon === 1, `${at} File is shown disabled (coming soon)`);
      const adds = await page.locator(tid("debug-chat-attach-add")).count();
      check(adds === 2, `${at} the Add group lists the host's items (${adds})`);
      const focusKept = await page.evaluate(
        () => document.activeElement?.dataset.testid === "debug-chat-input",
      );
      check(focusKept, `${at} the + menu keeps the input's focus`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${colorScheme}-menu.png`) });
      await item.tap();
      await page.waitForSelector(tid("debug-chat-attached"));
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${colorScheme}-chip.png`) });

      // 2. Send: the line carries the context; the chip goes; the log quotes it.
      await page.fill(tid("debug-chat-input"), "what does canapé mean?");
      await page.press(tid("debug-chat-input"), "Enter");
      const s1 = await sentLast();
      check(
        s1?.context?.selection === TEXT && s1.context.path === "/harness",
        `${at} sent with context (${JSON.stringify(s1?.context)})`,
      );
      check(
        (await page.locator(tid("debug-chat-attached")).count()) === 0,
        `${at} the chip is gone after the send`,
      );
      const quote = page.locator(tid("debug-chat-quote")).last();
      check(
        (await quote.count()) === 1 && (await quote.textContent()).includes("Le chat noir"),
        `${at} the log shows the quote above the line`,
      );
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${colorScheme}-sent.png`) });

      // 3. Attach, then ×: the next line goes without.
      await selectText();
      await page.tap(tid("debug-chat-input"));
      await page.tap(tid("debug-chat-attach"));
      await page.locator(tid("debug-chat-attach-selection")).tap();
      await page.locator(tid("debug-chat-attached-remove")).tap();
      await page.fill(tid("debug-chat-input"), "no quote this time");
      await page.press(tid("debug-chat-input"), "Enter");
      check((await sentLast())?.context === null, `${at} × drops it for this line`);

      // 4. A tap elsewhere on the page forgets the selection.
      await selectText();
      await page.touchscreen.tap(30, 160);
      await page.tap(tid("debug-chat-input"));
      await page.tap(tid("debug-chat-attach"));
      check(
        await page.locator(tid("debug-chat-attach-selection")).isDisabled(),
        `${at} a tap elsewhere forgets the selection`,
      );
      await page.keyboard.press("Escape");

      // 5. A password field's selection is never read.
      await page.evaluate(() => {
        const i = document.querySelector('[data-testid="harness-password"]');
        i.focus();
        i.select();
      });
      await page.waitForTimeout(50);
      await page.tap(tid("debug-chat-input"));
      await page.tap(tid("debug-chat-attach"));
      check(
        await page.locator(tid("debug-chat-attach-selection")).isDisabled(),
        `${at} a password field is never captured`,
      );

      // 6. An Add item runs the host's action and closes the menu.
      await page.locator(tid("debug-chat-attach-add")).first().tap();
      const picked = await page.evaluate(() => window.__picked?.at(-1));
      check(
        picked === "create:link" &&
          (await page.locator(tid("debug-chat-attach-menu")).count()) === 0,
        `${at} an Add item runs and closes the menu`,
      );
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall attach checks passed");
