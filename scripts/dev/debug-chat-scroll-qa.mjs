#!/usr/bin/env bun
/**
 * Browser checks for the chat log's scroll position on the local /harness
 * page (the hot widget), in an Android-sized touch viewport (412×915):
 *
 *   - a drag on the empty input moves the log 1:1 with the finger (it once
 *     moved twice: a touch handler and the pointer handler both scrolled)
 *   - at the end, short drags up or down, and one pushed past the joystick's
 *     dead zone, keep the newest line in view throughout and land back at the
 *     end on release (the 2026-11-03 bug: the fold kept the tall view's
 *     centre line, so the log showed chat from far back)
 *   - a drag that scrolled the newest line out keeps what he was reading
 *   - scrolled up before a drag, the lines he was reading stay in view
 *   - moving the box by its mark, and the viewport shrinking (the keyboard),
 *     keep a log at its end at its end, and a scrolled-up log where it was
 *
 * Browsers are muted (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-scroll-qa.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";
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

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(what);
};

const N = 80;
const browser = await launchSilent(chromium);
const ctx = await newSilentContext(browser, {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
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

const COL = '[data-testid="debug-chat-column"]';
/** The log's gap below the view, and the message numbers in view. */
const state = () =>
  page.evaluate((col) => {
    const el = document.querySelector(col);
    const v = el.getBoundingClientRect();
    const shown = [...el.querySelectorAll("[data-testid=debug-chat-line]")]
      .filter((l) => {
        const b = l.getBoundingClientRect();
        return b.bottom > v.top + 2 && b.top < v.bottom - 2;
      })
      .map((l) => Number(l.innerText.match(/#(\d+)#/)?.[1]))
      .filter((n) => Number.isFinite(n));
    return {
      gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      top: el.scrollTop,
      shown,
      full: el.dataset.full ?? "off",
    };
  }, COL);
const toEnd = () =>
  page.evaluate((col) => {
    const el = document.querySelector(col);
    el.scrollTop = el.scrollHeight;
  }, COL);
const scrollUp = (px) =>
  page.evaluate(
    ([col, px]) => {
      const el = document.querySelector(col);
      el.scrollTop = el.scrollHeight - el.clientHeight - px;
    },
    [COL, px],
  );
const touch = (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y }],
  });
const centre = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** A touch drag from `sel` through the `dys` (offsets from the press), with `each` run at every step. */
const drag = async (sel, steps, each) => {
  const p = await centre(sel);
  await touch("touchStart", p.x, p.y);
  for (const s of steps) {
    const [dx, dy, wait] = Array.isArray(s) ? s : [0, s, 30];
    await touch("touchMove", p.x + dx, p.y + dy);
    await page.waitForTimeout(wait);
    if (each) await each(await state());
  }
  await touch("touchEnd");
  await page.waitForTimeout(500);
  return state();
};
const newest = N - 1;
const INPUT = '[data-testid="debug-chat-input"]';

try {
  await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
  await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++)
      globalThis.__push(
        `#${i}# ${"这是一条很长的聊天记录，用来测试滚动。".repeat(1 + (i % 3))}`,
        i % 2 ? "agent" : "owner",
      );
  }, N);
  await page.waitForTimeout(500);
  let s = await state();
  check(s.gap <= 2 && s.shown.includes(newest), "starts at the newest line", JSON.stringify(s));

  // 1:1 with the finger.
  {
    const p = await centre(INPUT);
    await touch("touchStart", p.x, p.y);
    await touch("touchMove", p.x, p.y + 8);
    await page.waitForTimeout(80);
    const a = (await state()).top;
    await touch("touchMove", p.x, p.y + 18);
    await page.waitForTimeout(80);
    const b = (await state()).top;
    await touch("touchMove", p.x, p.y + 28);
    await page.waitForTimeout(80);
    const c = (await state()).top;
    await touch("touchEnd");
    await page.waitForTimeout(500);
    const d = [a - b, b - c];
    check(
      d.every((x) => Math.abs(x - 10) <= 2),
      "the log moves 1:1 with the finger",
      `10px of finger → ${d.join(", ")} px`,
    );
  }

  // At the end: short drags (and one past the dead zone, briefly) come back to the end.
  for (const [label, steps] of [
    ["up 24px", [-4, -8, -12, -16, -20, -24]],
    ["down 24px", [4, 8, 12, 16, 20, 24]],
    ["down past the dead zone", [10, 20, 30, 40, [0, 50, 60], [0, 30, 30], [0, 20, 30]]],
    ["up then down", [-10, -20, -10, 0, 10, 20, 10]],
  ]) {
    await toEnd();
    await page.waitForTimeout(250);
    let lost = null;
    s = await drag(INPUT, steps, (st) => {
      if (!st.shown.includes(newest)) lost ??= JSON.stringify(st);
    });
    check(!lost, `at the end, drag ${label}: the newest line stays in view throughout`, lost);
    check(
      s.gap <= 24 && s.shown.includes(newest),
      `at the end, drag ${label}: back at the newest line on release`,
      JSON.stringify(s),
    );
  }

  // A drag that scrolled the newest line out: he is reading back there. On
  // release the resting log shows the lines that were in its place.
  {
    await toEnd();
    await page.waitForTimeout(250);
    const rest = await page.locator(COL).boundingBox();
    const inRest = () =>
      page.evaluate(
        ([col, r]) =>
          [...document.querySelector(col).querySelectorAll("[data-testid=debug-chat-line]")]
            .filter((l) => {
              const b = l.getBoundingClientRect();
              return b.bottom > r.y && b.top < r.y + r.height;
            })
            .map((l) => Number(l.innerText.match(/#(\d+)#/)?.[1])),
        [COL, rest],
      );
    let during = null;
    let there = [];
    s = await drag(INPUT, [10, 20, 30, 40, [0, 90, 700], [0, 90, 30]], async (st) => {
      during = st;
      there = await inRest();
    });
    check(
      during.shown.length > 0 && !during.shown.includes(newest),
      "a long drag back scrolls the newest line out",
      JSON.stringify(during),
    );
    check(
      s.gap > 24 && s.shown.some((n) => there.includes(n)),
      "on release the resting log shows the lines that were in its place",
      JSON.stringify({ there, after: s }),
    );
  }

  // Scrolled up before the drag: a short drag keeps those lines.
  {
    await scrollUp(1200);
    await page.waitForTimeout(300);
    const before = await state();
    s = await drag(INPUT, [-4, -8, -12, -8, -4, 0]);
    check(
      s.gap > 24 && s.shown.some((n) => before.shown.includes(n)),
      "scrolled up: a short drag keeps the lines he was reading",
      JSON.stringify({ before, after: s }),
    );
  }

  // Moving the box by its mark.
  const MARK = '[data-testid="debug-chat-pill-min"]';
  {
    await toEnd();
    await page.waitForTimeout(250);
    let lost = null;
    s = await drag(MARK, [-20, -60, -120, -200, -260, -200, -120, -40, 0], (st) => {
      if (st.gap > 24) lost ??= JSON.stringify(st);
    });
    check(
      !lost && s.gap <= 24,
      "at the end, moving the box keeps the newest line",
      lost ?? JSON.stringify(s),
    );
    await scrollUp(900);
    await page.waitForTimeout(300);
    const before = await state();
    s = await drag(MARK, [-20, -60, -120, -200, -120, -40, 0]);
    check(
      s.gap > 24 && s.shown.some((n) => before.shown.includes(n)),
      "scrolled up, moving the box keeps his place",
      JSON.stringify({ before, after: s }),
    );
  }

  // The focused input (the log opens to 30vh), then the keyboard shrinking the viewport.
  {
    await page.locator(INPUT).focus();
    await page.waitForTimeout(400);
    await toEnd();
    await page.waitForTimeout(250);
    await page.setViewportSize({ width: 412, height: 560 });
    await page.waitForTimeout(500);
    s = await state();
    check(
      s.gap <= 24 && s.shown.includes(newest),
      "the keyboard (a shorter viewport) keeps the end",
      JSON.stringify(s),
    );
    await page.setViewportSize({ width: 412, height: 915 });
    await page.waitForTimeout(500);
    s = await state();
    check(s.gap <= 24, "and the keyboard going away too", JSON.stringify(s));
    await page.locator(INPUT).blur();
    await page.waitForTimeout(400);
    s = await state();
    check(
      s.gap <= 24 && s.shown.includes(newest),
      "the blur lands on the newest line",
      JSON.stringify(s),
    );
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");
