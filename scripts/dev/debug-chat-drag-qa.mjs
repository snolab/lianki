#!/usr/bin/env bun
/**
 * Browser checks for a vertical drag on the chat's empty input (the
 * full-screen log) on the local /harness page, with the hot widget, at
 * iPhone (390×844) and Android (412×915) sizes, light and dark:
 *
 *   - no full-screen blur (owner, 2026-11-03 20:50 JST: "在输入框上拖动的这个
 *     全屏背景模糊"): during and after the drag, no element with a
 *     backdrop-filter reaches past the chat panel (the log's box and the
 *     bar, plus the glass's few px of edge), and no full-viewport layer at all
 *   - the glass that is up is the panel's own, in oklch
 *   - the log stays under the finger (owner: "开始拖动之后的输入框/聊天内容老是
 *     不在一个位置"): the line nearest the finger keeps the same offset from
 *     the finger, within a pixel, from the first move past the touch slop
 *     (AXIS_LOCK_PX) to the last; before the slop nothing moves (a tap is
 *     still a tap); and on release nothing jumps
 *
 * getUserMedia is refused; browsers are muted (scripts/qa/silent.mjs).
 *
 *   bun scripts/dev/debug-chat-drag-qa.mjs [--shots <dir>]
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
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(what);
};

const INPUT = '[data-testid="debug-chat-input"]';
/** The touch slop (tap-gesture.ts AXIS_LOCK_PX). */
const SLOP = 8;
/** The glass's own edge past the panel (typing glass: -inset-1.5), with a pixel to spare. */
const EDGE = 8;

const SIZES = [
  { name: "iPhone", width: 390, height: 844, deviceScaleFactor: 3 },
  { name: "Android", width: 412, height: 915, deviceScaleFactor: 2.625 },
];

/** Every painted backdrop-filter, and whether it stays inside the chat panel. */
const blurs = (page) =>
  page.evaluate(
    ([edge]) => {
      const rect = (sel) => {
        const e = document.querySelector(sel);
        if (!e || e.hidden) return null;
        const r = e.getBoundingClientRect();
        return r.width && r.height ? r : null;
      };
      const parts = [
        rect('[data-testid="debug-chat-column"]'),
        rect('[data-testid="debug-chat-pill"]'),
      ].filter(Boolean);
      const panel = {
        left: Math.min(...parts.map((r) => r.left)) - edge,
        top: Math.min(...parts.map((r) => r.top)) - edge,
        right: Math.max(...parts.map((r) => r.right)) + edge,
        bottom: Math.max(...parts.map((r) => r.bottom)) + edge,
      };
      const out = [];
      let filters = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        const f = cs.backdropFilter || cs.webkitBackdropFilter;
        if (!f || f === "none") continue;
        if (cs.visibility === "hidden" || Number(cs.opacity) === 0 || cs.display === "none")
          continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const id = el.dataset.testid || el.tagName.toLowerCase();
        filters.push({ id, f, bg: el.style.background });
        const full = r.width >= innerWidth && r.height >= innerHeight;
        if (
          full ||
          r.left < panel.left ||
          r.top < panel.top ||
          r.right > panel.right ||
          r.bottom > panel.bottom
        )
          out.push(
            `${id} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`,
          );
      }
      return { out, filters, panelH: Math.round(panel.bottom - panel.top) };
    },
    [EDGE],
  );

/** The line nearest `y` (viewport px), by its message id, or that line's top now. */
const lineAt = (page, y) =>
  page.evaluate((y) => {
    let best = null;
    for (const l of document.querySelectorAll("[data-testid=debug-chat-line]")) {
      const b = l.getBoundingClientRect();
      if (!b.height) continue;
      const d = Math.abs((b.top + b.bottom) / 2 - y);
      if (!best || d < best.d) best = { d, id: l.dataset.msg };
    }
    return best?.id ?? null;
  }, y);
const topOf = (page, id) =>
  page.evaluate((id) => {
    const l = document.querySelector(`[data-testid=debug-chat-line][data-msg="${id}"]`);
    return l ? l.getBoundingClientRect().top : null;
  }, id);

const browser = await launchSilent(chromium);
try {
  for (const size of SIZES) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${size.name} ${scheme}`;
      const ctx = await newSilentContext(browser, {
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.deviceScaleFactor,
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
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, x, y) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x, y }],
        });
      await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
      await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
      await page.waitForTimeout(400);
      // A busy page behind, and a long chat to scroll.
      await page.evaluate(() => {
        const main = document.createElement("main");
        main.style.cssText = "position:absolute;inset:0;padding:1rem;font:20px/1.5 system-ui;";
        main.innerHTML = Array.from(
          { length: 18 },
          (_, i) =>
            `<p style="margin:.4rem 0;padding:.5rem;border-radius:.5rem;background:oklch(${i % 2 ? "0.85 0.08 150" : "0.8 0.1 30"} / 0.6)">row ${i + 1} on the page</p>`,
        ).join("");
        document.body.prepend(main);
        for (let i = 0; i < 40; i++)
          globalThis.__push(
            `#${i}# ${"这是一条聊天记录，用来测试拖动。".repeat(1 + (i % 3))}`,
            i % 2 ? "agent" : "owner",
          );
      });
      await page.waitForTimeout(500);

      // Two drags: finger down (older lines) from the end, then finger up
      // (back toward the newest) from where the first left the log.
      // At the end, a short drag rubber-bands back to the newest line on
      // release (#443); scrolled up, he is reading: it lands where he left it.
      for (const [label, sign, from] of [
        ["down at the end", 1, "end"],
        ["down, scrolled up", 1, 600],
        ["up, scrolled up", -1, 600],
      ]) {
        const t = `${tag}, drag ${label}`;
        await page.evaluate((from) => {
          const el = document.querySelector('[data-testid="debug-chat-column"]');
          el.scrollTop =
            from === "end" ? el.scrollHeight : el.scrollHeight - el.clientHeight - from;
        }, from);
        await page.waitForTimeout(300);
        const b = await page.locator(INPUT).boundingBox();
        const x = b.x + b.width / 2;
        const y0 = b.y + b.height / 2;
        const col = await page.locator('[data-testid="debug-chat-column"]').boundingBox();
        // The line he is looking at: the one in the middle of the resting log.
        const ref = await lineAt(page, col.y + col.height / 2);
        const press = (await topOf(page, ref)) - y0;
        await touch("touchStart", x, y0);
        await page.waitForTimeout(50);
        // Under the slop: a tap still, nothing moves.
        await touch("touchMove", x, y0 + (sign * SLOP) / 2);
        await page.waitForTimeout(50);
        check(
          Math.abs((await topOf(page, ref)) - y0 - press) <= 1,
          `${t}: under the touch slop nothing moves`,
        );
        // Past the slop, inside the joystick's dead zone (joystick.ts radius
        // 40; beyond it the log scrolls on its own by speed, by design).
        const steps = [SLOP + 1, 14, 22, 30, 37, 30, 20, 12].map((d) => d * sign);
        const offsets = [];
        const during = [];
        for (const [i, dy] of steps.entries()) {
          await touch("touchMove", x, y0 + dy);
          // The first one switches to the full-screen log: let it settle.
          await page.waitForTimeout(i === 0 ? 260 : 40);
          offsets.push((await topOf(page, ref)) - (y0 + dy));
          if (i === 0 || i === 4) during.push(await blurs(page));
          if (i === 4 && SHOTS) {
            mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({
              path: join(SHOTS, `drag-${label}-${size.name}-${scheme}.png`),
            });
          }
        }
        // Start, mid, end: the same offset from the finger as at the press.
        const all = [press, ...offsets];
        const spread = Math.max(...all) - Math.min(...all);
        check(
          spread <= 1,
          `${t}: the log stays under the finger from the press to the end (spread ${spread.toFixed(1)} px)`,
          all.map((o) => o.toFixed(1)).join(", "),
        );
        for (const [i, d] of during.entries())
          check(
            d.out.length === 0,
            `${t}: ${i ? "mid" : "start of"} drag: no blur past the chat panel`,
            `${d.out.join("; ")} (panel ${d.panelH}px high; ${JSON.stringify(d.filters)})`,
          );
        check(
          during[1].filters.some((f) => /oklch\(/.test(f.bg) && /blur/.test(f.f)),
          `${t}: mid drag the panel's own oklch glass is up`,
          JSON.stringify(during[1].filters),
        );
        const lastY = y0 + steps.at(-1);
        const before = (await topOf(page, ref)) - lastY;
        await touch("touchEnd");
        await page.waitForTimeout(30);
        const rel0 = await blurs(page);
        check(
          rel0.out.length === 0,
          `${t}: on release: no blur past the chat panel`,
          rel0.out.join("; "),
        );
        await page.waitForTimeout(500);
        const rel = await blurs(page);
        check(
          rel.out.length === 0,
          `${t}: after the drag: no blur past the chat panel`,
          rel.out.join("; "),
        );
        const after = (await topOf(page, ref)) - lastY;
        if (from === "end")
          check(
            (await page.evaluate(() => {
              const el = document.querySelector('[data-testid="debug-chat-column"]');
              return el.scrollHeight - el.scrollTop - el.clientHeight;
            })) <= 2,
            `${t}: on release back at the newest line`,
          );
        else
          check(
            Math.abs(after - before) <= 1,
            `${t}: release lands where the finger left it (${before.toFixed(1)} → ${after.toFixed(1)})`,
          );
        if (SHOTS)
          await page.screenshot({
            path: join(SHOTS, `drag-${label}-after-${size.name}-${scheme}.png`),
          });
      }
      // The mic takes the same vertical drag (the log grows upward, the bar
      // stays): the glass is the panel's, the log and the bar, one frame.
      {
        const m = await page.locator('[data-testid="debug-chat-mic"]').boundingBox();
        const mx = m.x + m.width / 2;
        const my = m.y + m.height / 2;
        await touch("touchStart", mx, my);
        for (const dy of [SLOP + 1, 16, 24]) {
          await touch("touchMove", mx, my + dy);
          await page.waitForTimeout(dy === 24 ? 300 : 40);
        }
        const d = await blurs(page);
        check(
          d.out.length === 0,
          `${tag}, drag on the mic: no blur past the chat panel`,
          d.out.join("; "),
        );
        check(
          d.filters.some((f) => f.id === "debug-chat-typing-glass" && /oklch\(/.test(f.bg)),
          `${tag}, drag on the mic: the panel's own oklch glass is up`,
          JSON.stringify(d.filters),
        );
        if (SHOTS)
          await page.screenshot({ path: join(SHOTS, `drag-mic-${size.name}-${scheme}.png`) });
        await touch("touchEnd");
        await page.waitForTimeout(500);
        const a = await blurs(page);
        check(
          a.out.length === 0,
          `${tag}, drag on the mic: after it, no blur past the chat panel`,
          a.out.join("; "),
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
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall drag checks passed");
