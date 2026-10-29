#!/usr/bin/env node
/**
 * Browser checks for the debug chat's bar (packages/debug-chat/src/DebugChat.tsx)
 * on the local /harness page — no lianki-push needed. Boots the widget server
 * on a free port, loads the hot widget (so its Tailwind CSS is there too), and
 * checks, expanded and minimized:
 *
 *   - one container: minimize → connections → mic → input, in tab order
 *   - the input is 16px or more (iOS zooms into anything smaller)
 *   - each control is a 40px tap target
 *   - minimized, the input is inert: it cannot take focus, and Tab skips it
 *   - minimized, the mic is still on top and clickable
 *   - a vertical drag on the mic scrubs the history (floating lines), a
 *     horizontal one moves the bar, and neither toggles the mic
 *   - a message arriving while minimized floats above the bar
 *
 * getUserMedia is stubbed (counted, then refused): nothing is ever recorded.
 *
 *   node scripts/dev/debug-chat-bar-qa.mjs [--shots <dir>]
 *     --shots: also save light/dark × expanded/minimized at 390px wide there
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";

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
// Ready when it says it is listening (an event, not a poll).
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

const browser = await chromium.launch();
try {
  const open = async (query, colorScheme = "light") => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme,
      hasTouch: false,
    });
    await ctx.addInitScript((src) => {
      localStorage.setItem("lk:debug-widget-src", src);
      window.__gum = 0;
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          window.__gum++;
          throw new DOMException("refused in QA", "NotAllowedError");
        };
    }, `${ORIGIN}/debug-chat.js`);
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/harness${query}`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    await page.waitForTimeout(400); // the width transition
    return { ctx, page };
  };
  const tabOrder = (page) =>
    page.evaluate(async () => {
      const ids = [];
      document.querySelector('[data-testid="debug-chat-pill-min"]').focus();
      for (let i = 0; i < 4; i++) {
        ids.push(document.activeElement?.dataset.testid ?? document.activeElement?.tagName);
        // Synthetic Tab is not trusted; walk the tab order by hand instead.
        const all = [...document.querySelectorAll("button, textarea, [tabindex]")].filter(
          (el) => !el.closest("[inert]") && !el.disabled && el.getClientRects().length > 0,
        );
        all[all.indexOf(document.activeElement) + 1]?.focus();
      }
      return ids;
    });

  // Expanded.
  {
    const { ctx, page } = await open("?open");
    const r = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const bar = q("debug-chat-pill");
      const ta = q("debug-chat-input");
      const kids = ["debug-chat-pill-min", "debug-chat-pill-menu", "debug-chat-mic"].map((id) =>
        bar.contains(q(id)),
      );
      const target = (el) => {
        const r = el.getBoundingClientRect();
        const before = getComputedStyle(el, "::before");
        return Math.min(r.width, Math.max(r.height, Number.parseFloat(before.height) || 0));
      };
      return {
        inBar: kids.every(Boolean) && bar.contains(ta),
        font: Number.parseFloat(getComputedStyle(ta).fontSize),
        targets: ["debug-chat-pill-min", "debug-chat-pill-menu", "debug-chat-mic"].map((id) =>
          target(q(id)),
        ),
        expanded: q("debug-chat-pill-min").getAttribute("aria-expanded"),
        width: bar.getBoundingClientRect().width,
      };
    });
    check(r.inBar, "expanded: controls and input share one container");
    check(r.font >= 16, `expanded: input font-size ${r.font}px ≥ 16px`);
    check(
      r.targets.every((t) => t >= 40),
      `controls are ≥ 40px tap targets (${r.targets.join(", ")})`,
    );
    check(r.expanded === "true", "minimize button has aria-expanded=true");
    const order = await tabOrder(page);
    check(
      order.join() === "debug-chat-pill-min,debug-chat-pill-menu,debug-chat-mic,debug-chat-input",
      `expanded focus order: ${order.join(" → ")}`,
    );
    // Tap the mark: minimizes after the double-tap window, the bar shrinks.
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat-minimized"]');
    await page.waitForTimeout(400);
    const w = await page.evaluate(
      () => document.querySelector('[data-testid="debug-chat-pill"]').getBoundingClientRect().width,
    );
    check(w < r.width / 2, `minimizing shrinks the bar (${r.width} → ${w}px)`);
    if (SHOTS) {
      await page.click('[data-testid="debug-chat-pill-min"]');
      await page.waitForSelector('[data-testid="debug-chat"]');
      await page.waitForTimeout(400);
    }
    await ctx.close();
  }

  // Minimized.
  {
    const { ctx, page } = await open("?min");
    const r = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const ta = q("debug-chat-input");
      ta.focus();
      const mic = q("debug-chat-mic");
      const m = mic.getBoundingClientRect();
      const hit = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
      return {
        focused: document.activeElement === ta,
        inert: !!ta.closest("[inert]") && ta.closest("[aria-hidden=true]") !== null,
        micOnTop: hit === mic || mic.contains(hit),
        logHidden: q("debug-chat-log").hidden,
        expanded: q("debug-chat-pill-min").getAttribute("aria-expanded"),
      };
    });
    check(!r.focused, "minimized: the input cannot take focus");
    check(r.inert, "minimized: the input is inert and aria-hidden");
    check(r.micOnTop, "minimized: the mic is on top, not covered");
    check(r.logHidden, "minimized: the log is hidden");
    check(r.expanded === "false", "minimize button has aria-expanded=false");
    const order = await tabOrder(page);
    check(
      !order.includes("debug-chat-input"),
      `minimized focus order skips the input: ${order.join(" → ")}`,
    );

    const mic = await page.locator('[data-testid="debug-chat-mic"]').boundingBox();
    const cx = mic.x + mic.width / 2;
    const cy = mic.y + mic.height / 2;
    // A vertical drag: scrubs, shows lines, and does not toggle the mic.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx, cy + i * 10);
    const during = await page.locator('[data-testid="debug-chat-float"]').allTextContents();
    await page.mouse.up();
    check(during.length > 0, `scrub shows earlier lines (${during.at(-1) ?? "none"})`);
    check(during.at(-1) !== "agent:message 29", "dragging down goes back past the newest line");
    check((await page.evaluate(() => window.__gum)) === 0, "a scrub does not toggle the mic");
    // A horizontal drag on the mic moves the bar, and does not toggle it either.
    const before = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(cx - i * 10, cy);
    await page.mouse.up();
    const after = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
    check(
      after.x < before.x - 30,
      `a sideways drag on the mic moves the bar (${before.x} → ${after.x})`,
    );
    check((await page.evaluate(() => window.__gum)) === 0, "a move does not toggle the mic");
    // A plain tap still reaches the mic (the stub counts the request, then refuses it).
    await page.waitForTimeout(500);
    const m2 = await page.locator('[data-testid="debug-chat-mic"]').boundingBox();
    await page.mouse.click(m2.x + m2.width / 2, m2.y + m2.height / 2);
    await page.waitForFunction(() => window.__gum > 0, null, { timeout: 5000 }).catch(() => {});
    check(
      (await page.evaluate(() => window.__gum)) === 1,
      "minimized: a tap on the mic turns it on",
    );
    // Keyboard: ArrowUp on the focused mic scrubs too.
    await ctx.close();
  }

  {
    const { ctx, page } = await open("?min");
    await page.focus('[data-testid="debug-chat-mic"]');
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    const lines = await page.locator('[data-testid="debug-chat-float"]').allTextContents();
    check(lines.at(-1) === "you:message 28", `ArrowUp on the mic scrubs (${lines.at(-1)})`);
    await page.keyboard.press("ArrowDown");
    const lines2 = await page.locator('[data-testid="debug-chat-float"]').allTextContents();
    check(lines2.at(-1) === "agent:message 29", "ArrowDown comes back to the newest");
    await ctx.close();
  }

  // A live message floats above the minimized bar.
  {
    const { ctx, page } = await open("?min");
    await page.evaluate(() => window.__push("a reply that arrived while minimized"));
    await page
      .waitForSelector('[data-testid="debug-chat-float"]', { timeout: 3000 })
      .catch(() => {});
    const f = await page.locator('[data-testid="debug-chat-float"]').allTextContents();
    check(
      f.some((t) => t.includes("arrived while minimized")),
      "a new message floats above the minimized bar",
    );
    await ctx.close();
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ["light", "dark"])
      for (const state of ["expanded", "minimized"]) {
        const { ctx, page } = await open(state === "minimized" ? "?min" : "?open", scheme);
        if (state === "minimized") {
          await page.evaluate(() => {
            window.__push("今日はここまで。明日また続けましょう。");
            window.__push("Pushed the fix; the bar is one container now.");
          });
          await page.waitForTimeout(300);
        } else {
          await page.fill('[data-testid="debug-chat-input"]', "a draft in the unified bar");
          await page.locator('[data-testid="debug-chat-input"]').blur();
          await page.waitForTimeout(300);
        }
        const file = join(SHOTS, `bar-${state}-${scheme}.png`);
        await page.screenshot({ path: file });
        // And a close-up of the corner.
        await page.screenshot({
          path: join(SHOTS, `bar-${state}-${scheme}-zoom.png`),
          clip: { x: 0, y: 844 - 260, width: 390, height: 260 },
        });
        console.log(`shot ${file}`);
        await ctx.close();
      }
  }
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall bar checks passed");
