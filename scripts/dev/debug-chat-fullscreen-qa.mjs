#!/usr/bin/env bun
/**
 * Browser checks for the chat's full screen (full-screen.ts) on the local
 * /harness page, hot widget, in Chromium and WebKit, light and dark, at iPhone
 * size (390×844), the narrowest phone (320×568) and a desktop (1280×800):
 *
 *   - the flag gate: no button without `?full` (the harness is not the owner)
 *   - the button: an svg, a 40px tap target, labelled; a tap fills the screen
 *     and the same button returns to the panel, at the same place and size
 *   - the switch keeps the thread, the draft, the focus, the line being read,
 *     and the very same input and mic elements (nothing remounts)
 *   - no horizontal scroll at 320 px; the column is capped on a desktop
 *   - Escape and Back leave full screen; a reload keeps it (per device)
 *   - the keyboard, as far as emulation goes: the visual viewport shrunk and
 *     panned (iOS), the box follows it and the bar stays above its bottom
 *   - in full screen: scroll-down, the up-arrow to an open ask and its card,
 *     markdown, the mic button
 *
 * Browsers are muted (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-fullscreen-qa.mjs [--shots <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, webkit } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

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

const FULL = '[data-testid="debug-chat-fullscreen"]';
const SECTION = "[data-debug-widget] section[data-debug-chat]";
const COL = '[data-testid="debug-chat-column"]';
const BAR = '[data-testid="debug-chat-pill"]';
const INPUT = '[data-testid="debug-chat-input"]';
const MIC = '[data-testid="debug-chat-mic"]';
const JUMP = '[data-testid="debug-chat-ask-jump"]';
const DOWN = '[data-testid="debug-chat-bottom"]';

const askOf = (askId) => ({
  askId,
  questions: [
    {
      id: "q1",
      question: `Question ${askId}?`,
      options: [
        { id: "yes", label: "Merge it now", recommended: true },
        { id: "no", label: "Wait" },
      ],
    },
  ],
});

async function run(engine, name, scheme, vp) {
  const phone = vp.width < 500;
  const browser = await launchSilent(engine);
  const ctx = await newSilentContext(browser, {
    viewport: vp,
    deviceScaleFactor: phone ? 3 : 1,
    hasTouch: phone,
    isMobile: phone && name === "chromium",
    colorScheme: scheme,
  });
  await ctx.addInitScript((src) => {
    localStorage.setItem("lk:debug-widget-src", src);
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("refused in QA", "NotAllowedError");
      };
  }, `${ORIGIN}/debug-chat.js`);
  const page = await ctx.newPage();
  const tag = `${name} ${scheme} ${vp.width}x${vp.height}:`;
  const settle = () => page.waitForTimeout(350);
  const tap = (sel) => (phone ? page.locator(sel).tap() : page.locator(sel).click());
  const box = (sel) => page.locator(sel).boundingBox();
  const isFull = () =>
    page
      .locator(`${SECTION}[data-fullscreen]`)
      .count()
      .then((n) => n > 0);
  // `turns`: the owner and the agent take turns, so each line is its own run.
  const lines = (from, n, turns = false) =>
    page.evaluate(
      ([from, n, turns]) => {
        for (let i = from; i < from + n; i++)
          globalThis.__push(
            `#${i}# ${"a line of the chat that takes some room ".repeat(2)}`,
            turns && i % 2 ? "owner" : "agent",
          );
      },
      [from, n, turns],
    );
  const noSideScroll = () =>
    page.evaluate(() => {
      const d = document.scrollingElement;
      const s = document.querySelector("section[data-debug-chat]").getBoundingClientRect();
      return { ok: d.scrollWidth <= innerWidth && s.right <= innerWidth + 0.5, w: d.scrollWidth };
    });
  const shot = async (what) => {
    if (shots)
      await page.screenshot({ path: `${shots}/${name}-${scheme}-${vp.width}-${what}.png` });
  };

  try {
    // The gate: off (no flag, not the owner), no button.
    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
    await page.waitForSelector(SECTION, { timeout: 60_000 });
    await settle();
    check((await page.locator(FULL).count()) === 0, `${tag} flag off, not owner: no button`);

    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree&full`);
    await page.waitForSelector(FULL, { timeout: 60_000 });
    await settle();
    await lines(0, 40);
    await page.evaluate(() => globalThis.__push("Some **bold** and `code` here", "agent"));
    await settle();
    const btn = await box(FULL);
    check(
      !!btn && btn.width >= 32 && btn.height >= 32,
      `${tag} the button is there`,
      JSON.stringify(btn),
    );
    check((await page.locator(`${FULL} svg`).count()) === 1, `${tag} its icon is an svg`);
    const hit = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = getComputedStyle(el, "::before");
      return { cls: el.classList.contains("tap-40"), w: r.width, h: r.height };
    }, FULL);
    check(hit.cls, `${tag} 40px tap target (tap-40)`, JSON.stringify(hit));
    check(!!(await page.locator(FULL).getAttribute("aria-label")), `${tag} labelled`);
    const panel = await box(SECTION);
    await shot("panel");

    // Typing a draft, scrolled up a little: then into full screen.
    await page.locator(INPUT).focus();
    await page.keyboard.type("@/wor");
    await page.evaluate((c) => {
      const el = document.querySelector(c);
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      el.scrollTop = 300;
      el.dispatchEvent(new Event("scroll"));
    }, COL);
    await settle();
    const before = await page.evaluate((c) => {
      const el = document.querySelector(c);
      const v = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll("[data-testid=debug-chat-line]")];
      const mid = (v.top + v.bottom) / 2;
      // The nearest line to the view's centre, as the chat's own anchor (pickAnchor).
      const dist = (r) => {
        const b = r.getBoundingClientRect();
        return mid < b.top ? b.top - mid : mid > b.bottom ? mid - b.bottom : 0;
      };
      const row = rows.reduce((a, r) => (dist(r) < dist(a) ? r : a));
      document.querySelector('[data-testid="debug-chat-input"]').__lkMark = 1;
      const mic = document.querySelector('[data-testid="debug-chat-mic"]');
      if (mic) mic.__lkMark = 1;
      return { id: row.dataset.msg, top: row.getBoundingClientRect().top };
    }, COL);
    await tap(FULL);
    await settle();
    check(await isFull(), `${tag} a tap: full screen`);
    const fs = await box(SECTION);
    check(
      Math.abs(fs.x) <= 1 &&
        Math.abs(fs.y) <= 1 &&
        Math.abs(fs.width - vp.width) <= 1 &&
        Math.abs(fs.height - vp.height) <= 1,
      `${tag} fills the screen`,
      JSON.stringify(fs),
    );
    const after = await page.evaluate(
      ([c, id]) => {
        const row = document.querySelector(`${c} [data-msg="${id}"]`);
        const input = document.querySelector('[data-testid="debug-chat-input"]');
        const mic = document.querySelector('[data-testid="debug-chat-mic"]');
        return {
          top: row?.getBoundingClientRect().top,
          bottom: row?.getBoundingClientRect().bottom,
          view: document.querySelector(c).getBoundingClientRect().toJSON(),
          clamped: (() => {
            const el = document.querySelector(c);
            return el.scrollTop <= 1 || el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
          })(),
          draft: input.value,
          sameInput: input.__lkMark === 1,
          sameMic: !mic || mic.__lkMark === 1,
          focused: document.activeElement === input,
        };
      },
      [COL, before.id],
    );
    check(after.draft === "@/wor", `${tag} the draft is kept`, after.draft);
    check(after.sameInput && after.sameMic, `${tag} the same input and mic (no remount)`);
    check(after.focused, `${tag} the input keeps its focus`);
    check(
      after.top !== undefined &&
        (Math.abs(after.top - before.top) <= 4 ||
          // No room to hold it (the log's scroll ran out): still in view.
          (after.clamped &&
            after.top >= after.view.top - 1 &&
            after.bottom <= after.view.bottom + 1)),
      `${tag} the line being read keeps its place`,
      JSON.stringify({ before, after }),
    );
    const col = await box(COL);
    const bar = await box(BAR);
    check(col.height > vp.height * 0.5, `${tag} the log takes the height`, `${col.height}`);
    check(bar.y + bar.height <= vp.height, `${tag} the bar is on screen`, JSON.stringify(bar));
    if (!phone)
      check(col.width <= 48 * 16 + 1, `${tag} desktop: a readable column (48rem)`, `${col.width}`);
    const side = await noSideScroll();
    check(side.ok, `${tag} no horizontal scroll`, JSON.stringify(side));
    check((await page.locator(`${COL} strong`).count()) > 0, `${tag} markdown renders`);
    check((await page.locator(MIC).count()) === 1, `${tag} the mic is there`);
    const exitBtn = await box(FULL);
    check(
      exitBtn && exitBtn.y >= 0 && exitBtn.x + exitBtn.width <= vp.width && exitBtn.width >= 40,
      `${tag} the minimise control: top corner, 40px`,
      JSON.stringify(exitBtn),
    );
    check(!!(await page.locator(DOWN).count()), `${tag} scrolled up: scroll-down shows`);
    await shot("full");

    // An open ask pushed off above: the arrow, and a tap brings the card in view.
    const toEnd = () =>
      page.evaluate((c) => {
        const el = document.querySelector(c);
        el.scrollTop = el.scrollHeight;
      }, COL);
    await toEnd();
    await settle();
    await page.evaluate((a) => globalThis.__ask(a), askOf("f1"));
    await settle();
    await toEnd();
    await settle();
    await lines(100, phone ? 30 : 160, true);
    await settle();
    await toEnd();
    await settle();
    check((await page.locator(JUMP).count()) === 1, `${tag} full screen: the up-arrow shows`);
    if (await page.locator(JUMP).count()) {
      const j = await box(JUMP);
      check(
        !!j && j.x + j.width <= vp.width && j.y + j.height <= bar.y + 1,
        `${tag} the arrow sits over the bar`,
        JSON.stringify(j),
      );
      await tap(JUMP);
      await settle();
      const inView = await page.evaluate((c) => {
        const log = document.querySelector(c).getBoundingClientRect();
        const card = document.querySelector('[data-ask="f1"]')?.getBoundingClientRect();
        return {
          ok: !!card && card.top >= log.top - 1 && card.bottom <= log.bottom + 1,
          log: [log.top, log.bottom],
          card: card && [card.top, card.bottom],
        };
      }, COL);
      check(inView.ok, `${tag} a tap: the card in view`, JSON.stringify(inView));
      await tap('[data-ask="f1"] [data-option="no"]');
      await settle();
      const st = await page.locator('[data-ask="f1"]').getAttribute("data-state");
      check(st !== "open", `${tag} the card's pill takes a tap`, String(st));
    }

    // The keyboard (emulated: the visual viewport shrinks and pans, as on iOS).
    const kb = await page.evaluate(() => {
      const vv = window.visualViewport;
      if (!vv) return null;
      const h = Math.round(innerHeight * 0.55);
      Object.defineProperty(vv, "height", { configurable: true, get: () => h });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 40 });
      vv.dispatchEvent(new Event("resize"));
      return h;
    });
    await settle();
    if (kb) {
      const s = await box(SECTION);
      const b = await box(BAR);
      check(
        Math.abs(s.y - 40) <= 1 && Math.abs(s.height - kb) <= 1,
        `${tag} keyboard: the box is the visible area`,
        JSON.stringify({ s, kb }),
      );
      check(
        b.y + b.height <= 40 + kb,
        `${tag} keyboard: the bar above it`,
        JSON.stringify({ b, kb }),
      );
      check(
        (await page.locator(`${SECTION}[data-kb]`).count()) === 1,
        `${tag} keyboard: no home-indicator padding`,
      );
      await shot("keyboard");
      await page.evaluate(() => {
        const vv = window.visualViewport;
        delete vv.height;
        delete vv.offsetTop;
        vv.dispatchEvent(new Event("resize"));
      });
      await settle();
      const s2 = await box(SECTION);
      check(
        Math.abs(s2.height - vp.height) <= 1,
        `${tag} keyboard closed: full height again`,
        JSON.stringify(s2),
      );
    }

    // Escape leaves (focus off the input first: the mic's Escape would too).
    await page.keyboard.press("Escape");
    await settle();
    check(!(await isFull()), `${tag} Escape: back to the panel`);
    const back = await box(SECTION);
    check(
      Math.abs(back.x + back.width - (panel.x + panel.width)) <= 2 &&
        Math.abs(back.y + back.height - (panel.y + panel.height)) <= 2 &&
        Math.abs(back.width - panel.width) <= 2,
      `${tag} the panel is where it was`,
      JSON.stringify({ panel, back }),
    );
    check((await page.locator(INPUT).inputValue()) === "@/wor", `${tag} the draft is still there`);

    // Back leaves too, and stays on the page.
    const url = page.url();
    await tap(FULL);
    await settle();
    check(await isFull(), `${tag} again: full screen`);
    await page.goBack();
    await settle();
    check(!(await isFull()), `${tag} Back: back to the panel`);
    check(page.url() === url, `${tag} Back stays on the page`, page.url());

    // The button's way back; then a reload keeps full screen (this device).
    await tap(FULL);
    await settle();
    await tap(FULL);
    await settle();
    check(!(await isFull()), `${tag} the minimise control: back to the panel`);
    const histLen = await page.evaluate(() => history.length);
    await tap(FULL);
    await settle();
    await page.reload();
    await page.waitForSelector(SECTION, { timeout: 60_000 });
    await settle();
    check(await isFull(), `${tag} a reload keeps full screen`);
    check(
      (await page.evaluate(() => history.length)) <= histLen + 1,
      `${tag} entries: one per tap at most`,
    );
    await page.keyboard.press("Escape");
    await settle();
    check(!(await isFull()), `${tag} after a reload, Escape leaves`);
  } finally {
    await browser.close();
  }
}

try {
  for (const [engine, name] of [
    [chromium, "chromium"],
    [webkit, "webkit"],
  ])
    for (const scheme of ["light", "dark"])
      for (const vp of [
        { width: 390, height: 844 },
        { width: 320, height: 568 },
        { width: 1280, height: 800 },
      ])
        await run(engine, name, scheme, vp);
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);
