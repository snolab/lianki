#!/usr/bin/env bun
/**
 * Browser checks for the chat's full screen (full-screen.ts) on the local
 * /harness page, hot widget, in Chromium and WebKit, light and dark, at iPhone
 * size (414×896, 390×844), the narrowest phone (320×568) and a desktop (1280×800):
 *
 *   - the flag gate: without `?full` (the harness is not the owner) a drop on
 *     the bottom edge stays a panel
 *   - no button to enter (owner, 2026-11-09 18:25 JST): the input bar dragged
 *     to the bottom edge fills the screen (a phone) or opens the right sidebar
 *     (wider than 35em); dragged to the top edge it stays a panel (18:26 JST);
 *     a drag up from full screen leaves it, the panel following the finger
 *   - the way out: ✕ alone with a label and tooltip, 40px, top corner, keyboard-focusable;
 *     the menu's Full screen row is the way in without a drag
 *   - the switch keeps the thread, the draft, the focus, the line being read,
 *     and the very same input and mic elements (nothing remounts)
 *   - the bar: the screen's width less the 8 px gutters on a phone, the
 *     sidebar's width (the log's) on a desktop; the input takes what it gained;
 *     nothing in the bar overlaps
 *   - the sidebar leaves the page beside it uncovered, reflowed and scrolling
 *   - no horizontal scroll at 320 px
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
import { budget } from "../qa/load-budget.mjs";

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

const r = (n) => Math.round(n * 10) / 10;
/** The old enter/exit toggle: gone (owner, 2026-11-09 18:25 JST). */
const OLD_TOGGLE = '[data-testid="debug-chat-fullscreen"]';
const EXIT = '[data-testid="debug-chat-fullscreen-exit"]';
const GRIP = '[data-testid="debug-chat-pill-min"]';
const MENU_FULL = '[data-testid="debug-menu-fullscreen"]';
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
  /**
   * Drag the input bar by its grip, in steps, to (x, y) (default: the grip's
   * own x). Past the screen's edge the drag keeps the bar on screen, flush.
   */
  const dragGrip = async (y, x) => {
    const g = await box(GRIP);
    const sx = g.x + g.width / 2;
    const sy = g.y + g.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(x ?? sx, y, { steps: 12 });
    await page.mouse.up();
    await settle();
  };
  /** The bar's bottom edge against the screen's bottom (flush, within a px). */
  const toBottom = () => dragGrip(vp.height - 1);

  try {
    // The gate: off (no flag, not the owner): a drop on the bottom edge stays a panel.
    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
    await page.waitForSelector(SECTION, { timeout: 60_000 });
    await settle();
    await toBottom();
    check(!(await isFull()), `${tag} flag off, not owner: the bottom edge stays a panel`);
    await page.evaluate(() => localStorage.removeItem("lk:debug-chat-pos"));

    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree&full`);
    await page.waitForSelector(SECTION, { timeout: 60_000 });
    await settle();
    await lines(0, 40);
    await page.evaluate(() => globalThis.__push("Some **bold** and `code` here", "agent"));
    await settle();
    check((await page.locator(OLD_TOGGLE).count()) === 0, `${tag} no button to enter full screen`);
    check((await page.locator(EXIT).count()) === 0, `${tag} the panel: no exit button`);

    // The top edge: it stays a panel there (it would hide the history).
    await dragGrip(0);
    const topBar = await box(BAR);
    check(topBar.y <= 1, `${tag} top edge: the bar is flush with it`, JSON.stringify(topBar));
    check(!(await isFull()), `${tag} top edge: no full screen`);
    await shot("top-edge");
    // Back down to the middle, then to where it was (the default place).
    await page.evaluate(() => localStorage.removeItem("lk:debug-chat-pos"));
    await page.reload();
    await page.waitForSelector(SECTION, { timeout: 60_000 });
    await settle();
    await lines(0, 40);
    await page.evaluate(() => globalThis.__push("Some **bold** and `code` here", "agent"));
    await settle();
    // Dropped short of the edge, by a few px: still a panel.
    {
      const b = await box(BAR);
      const g = await box(GRIP);
      await dragGrip(g.y + g.height / 2 + (vp.height - (b.y + b.height)) - 6);
      check(!(await isFull()), `${tag} near the bottom, not flush: still a panel`);
    }
    const panel = await box(SECTION);
    const barPanel = await box(BAR);
    const inputPanel = await box(INPUT);
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
    await toBottom();
    check(await isFull(), `${tag} dragged to the bottom edge: full screen`);
    const fs = await box(SECTION);
    // Wider than the owner's 35em (full-screen.ts SIDEBAR_QUERY): a sidebar
    // docked right, full height, 20–28rem; narrower: the whole screen.
    const sidebar = await page.evaluate(() => matchMedia("(min-width: 35em)").matches);
    check(
      sidebar === !phone,
      `${tag} ${phone ? "a phone: full screen" : "a desktop: the sidebar"}`,
    );
    if (sidebar)
      check(
        Math.abs(fs.x + fs.width - vp.width) <= 1 &&
          Math.abs(fs.y) <= 1 &&
          Math.abs(fs.height - vp.height) <= 1 &&
          fs.width >= 20 * 16 - 1 &&
          fs.width <= 28 * 16 + 1,
        `${tag} the sidebar: docked right, full height (${fs.width} px wide)`,
        JSON.stringify(fs),
      );
    else
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
          newest: (() => {
            const rows = document.querySelectorAll(`${c} [data-testid=debug-chat-line]`);
            const b = rows[rows.length - 1]?.getBoundingClientRect();
            const v = document.querySelector(c).getBoundingClientRect();
            return !!b && b.bottom <= v.bottom + 1 && b.top >= v.top - 1;
          })(),
        };
      },
      [COL, before.id],
    );
    check(after.draft === "@/wor", `${tag} the draft is kept`, after.draft);
    check(after.sameInput && after.sameMic, `${tag} the same input and mic (no remount)`);
    // The press on the grip leaves the input (as any drag of the chat does), so
    // the panel was at rest, at its newest line: full screen opens there too.
    check(after.newest, `${tag} full screen opens at the newest line`, JSON.stringify(after));
    const col = await box(COL);
    const bar = await box(BAR);
    check(col.height > vp.height * 0.5, `${tag} the log takes the height`, `${col.height}`);
    check(bar.y + bar.height <= vp.height, `${tag} the bar is on screen`, JSON.stringify(bar));
    // The bar: the screen less the safe areas and the panel's 0.5rem gutter
    // (no safe areas in emulation); in the sidebar, the sidebar's width, as the log.
    if (sidebar) {
      check(
        Math.abs(bar.width - col.width) <= 1 && Math.abs(bar.x - col.x) <= 1,
        `${tag} sidebar: bar and log share the width (${r(bar.width)} / ${r(col.width)})`,
        JSON.stringify({ bar, col }),
      );
      check(
        bar.x >= fs.x && bar.x + bar.width <= fs.x + fs.width + 0.5,
        `${tag} sidebar: the bar inside it`,
      );
      // The page beside it: not covered, reflowed clear of it, and it still scrolls.
      const pageSide = await page.evaluate((sideX) => {
        const tall = document.createElement("div");
        tall.id = "lk-qa-tall";
        tall.style.cssText = "height:3000px;width:100%;background:transparent";
        document.body.append(tall);
        const hit = document.elementFromPoint(sideX / 2, innerHeight / 2);
        const before = scrollY;
        scrollTo(0, 400);
        const scrolled = scrollY - before;
        scrollTo(0, before);
        const right = tall.getBoundingClientRect().right;
        tall.remove();
        return { covered: !!hit?.closest("[data-debug-widget]"), scrolled, right };
      }, fs.x);
      check(!pageSide.covered, `${tag} sidebar: the page beside it is not covered`);
      check(
        pageSide.scrolled > 0,
        `${tag} sidebar: the page beside it still scrolls`,
        JSON.stringify(pageSide),
      );
      check(
        pageSide.right <= fs.x + 1,
        `${tag} sidebar: the page's content reflows clear of it`,
        JSON.stringify(pageSide),
      );
    } else {
      check(
        Math.abs(bar.x - 8) <= 0.5 && Math.abs(bar.width - (vp.width - 16)) <= 0.5,
        `${tag} phone: the bar spans the screen less the 8 px gutters (${r(bar.width)} px)`,
        JSON.stringify(bar),
      );
    }
    const inputFull = await box(INPUT);
    // The input takes all the bar gained (at 320 px the panel already spans the screen).
    check(
      bar.width >= barPanel.width - 0.5 &&
        (vp.width <= 320 || inputFull.width > inputPanel.width) &&
        Math.abs(inputFull.width - inputPanel.width - (bar.width - barPanel.width)) <= 1,
      `${tag} the input grows with the bar (${r(inputPanel.width)} → ${r(inputFull.width)})`,
      JSON.stringify({ inputPanel, inputFull, barPanel, bar }),
    );
    // Nothing in the bar overlaps: mark, +, mic, input in a row.
    const rowOk = await page.evaluate(() => {
      const ids = [
        "debug-chat-pill-min",
        "debug-chat-attach",
        "debug-chat-mic",
        "debug-chat-input",
      ];
      const bs = ids
        .map((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect())
        .filter(Boolean);
      let ok = bs.length >= 3;
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 0.5) ok = false;
      const fsBtn = document
        .querySelector('[data-testid="debug-chat-fullscreen-exit"]')
        .getBoundingClientRect();
      const bar = document.querySelector('[data-testid="debug-chat-pill"]').getBoundingClientRect();
      if (fsBtn.bottom > bar.top + 0.5) ok = false;
      return { ok, xs: bs.map((b) => [Math.round(b.left), Math.round(b.right)]) };
    });
    check(rowOk.ok, `${tag} nothing in the bar overlaps`, JSON.stringify(rowOk));
    const side = await noSideScroll();
    check(side.ok, `${tag} no horizontal scroll`, JSON.stringify(side));
    check((await page.locator(`${COL} strong`).count()) > 0, `${tag} markdown renders`);
    check((await page.locator(MIC).count()) === 1, `${tag} the mic is there`);
    const exitBtn = await box(EXIT);
    check(
      exitBtn &&
        exitBtn.y >= 0 &&
        exitBtn.y + exitBtn.height <= col.y + 1 &&
        exitBtn.x + exitBtn.width <= vp.width &&
        exitBtn.height >= 40,
      `${tag} the exit button: top corner, above the log, 40px`,
      JSON.stringify(exitBtn),
    );
    const exitText = (await page.locator(EXIT).innerText()).trim();
    const exitLabel = (await page.locator(EXIT).getAttribute("aria-label"))?.trim();
    const exitTitle = (await page.locator(EXIT).getAttribute("title"))?.trim();
    check(
      exitText === "✕" && !!exitLabel && /\p{L}/u.test(exitLabel) && exitTitle === exitLabel,
      `${tag} the exit button: ✕ alone, named and described by its tooltip`,
      JSON.stringify({ exitText, exitLabel, exitTitle }),
    );
    // The icon against what is behind it: AA (4.5:1), computed in the page.
    const contrast = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const c = document.createElement("canvas").getContext("2d");
      const rgb = (css) => {
        c.fillStyle = "#000";
        c.fillStyle = css;
        c.fillRect(0, 0, 1, 1);
        const d = c.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const fg = rgb(getComputedStyle(el).color);
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      // Behind it: the near-opaque full-screen scrim over the page, at worst the page's own background.
      const bg = dark ? [24, 24, 27] : [250, 250, 250];
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return { ratio: (a + 0.05) / (b + 0.05), fg, bg };
    }, EXIT);
    check(contrast.ratio >= 4.5, `${tag} the exit button: AA contrast`, JSON.stringify(contrast));
    await page.evaluate((c) => {
      const el = document.querySelector(c);
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      el.scrollTop = 300;
      el.dispatchEvent(new Event("scroll"));
    }, COL);
    await settle();
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
    const backBar = await box(BAR);
    check(
      Math.abs(back.width - panel.width) <= 2 &&
        // Resting flush, it is shown KEYBOARD_GAP_PX (8) above the edge (keyboard-lift.ts).
        backBar.y + backBar.height >= vp.height - 8.5,
      `${tag} the panel as it was, where it was dropped (on the bottom edge)`,
      JSON.stringify({ panel, back, backBar }),
    );
    check((await page.locator(INPUT).inputValue()) === "@/wor", `${tag} the draft is still there`);

    // Back leaves too, and stays on the page.
    const url = page.url();
    await toBottom();
    check(await isFull(), `${tag} again: full screen`);
    await page.goBack();
    await settle();
    check(!(await isFull()), `${tag} Back: back to the panel`);
    check(page.url() === url, `${tag} Back stays on the page`, page.url());

    // A drag up leaves full screen; the panel comes back and follows the finger.
    await toBottom();
    check(await isFull(), `${tag} dragged down once more: full screen`);
    {
      const g = await box(GRIP);
      const sy = g.y + g.height / 2;
      const upTo = Math.round(vp.height * 0.45);
      // A small wobble up (under FULL_LEAVE_PX) stays full screen.
      await page.mouse.move(g.x + g.width / 2, sy);
      await page.mouse.down();
      await page.mouse.move(g.x + g.width / 2, sy - 20, { steps: 4 });
      await settle();
      check(await isFull(), `${tag} a 20 px wobble up: still full screen`);
      await page.mouse.move(g.x + g.width / 2, upTo, { steps: 14 });
      await page.mouse.up();
      await settle();
      check(!(await isFull()), `${tag} dragged up: back to the panel`);
      const s = await box(SECTION);
      const b = await box(BAR);
      check(
        Math.abs(s.width - panel.width) <= 2 && b.y + b.height < vp.height - 40,
        `${tag} dragged up: the panel's size, carried up with the finger`,
        JSON.stringify({ s, b, upTo }),
      );
      await shot("dragged-up");
    }

    // The exit button, from the keyboard: focus it, Enter.
    await toBottom();
    check(await isFull(), `${tag} full screen for the exit button`);
    await page.locator(EXIT).focus();
    check(
      await page.evaluate((sel) => document.activeElement === document.querySelector(sel), EXIT),
      `${tag} the exit button takes the keyboard focus`,
    );
    await page.keyboard.press("Enter");
    await settle();
    check(!(await isFull()), `${tag} the exit button (Enter): back to the panel`);

    // The way in without a drag: wait for the actual menu, not a fixed
    // delay followed by count(). Missing the menu used to skip entering full
    // screen, then report the skipped transition as a reload failure as well.
    await page.evaluate((sel) => {
      globalThis.__fullQaMenuClicks = [];
      document.querySelector(sel).addEventListener("click", (e) => {
        globalThis.__fullQaMenuClicks.push({ at: e.timeStamp, detail: e.detail });
      });
    }, GRIP);
    await page.locator(GRIP).dblclick();
    const menuFull = page.locator(MENU_FULL);
    try {
      await menuFull.waitFor({ state: "visible", timeout: budget(10_000) });
    } catch (error) {
      const state = await page.evaluate(
        (sel) => ({
          clicks: globalThis.__fullQaMenuClicks,
          minimized: document.querySelector(sel)?.hasAttribute("data-minimized"),
          full: document.querySelector(sel)?.hasAttribute("data-fullscreen"),
        }),
        SECTION,
      );
      throw new Error(`${tag} Full screen menu did not become visible: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
    check((await menuFull.count()) === 1, `${tag} the menu has a Full screen row`);
    const histLen = await page.evaluate(() => history.length);
    await menuFull.click();
    const waitForKeptFull = () =>
      page.waitForFunction(
        (sel) => {
          const full = document.querySelector(sel)?.hasAttribute("data-fullscreen");
          const saved = JSON.parse(localStorage.getItem("lk:pref:chat-view") ?? "null");
          return full && saved?.state?.full === true;
        },
        SECTION,
        { timeout: budget(10_000) },
      );
    await waitForKeptFull();
    check(await isFull(), `${tag} the menu row: full screen`);
    // Only reload after both the DOM transition and device preference are
    // confirmed. On reload a plain section can mount before full is restored.
    await page.reload();
    await page.waitForSelector(SECTION, { timeout: budget(60_000) });
    await waitForKeptFull();
    check(await isFull(), `${tag} a reload keeps full screen`);
    check(
      (await page.evaluate(() => history.length)) <= histLen + 1,
      `${tag} entries: one per entry at most`,
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
        { width: 414, height: 896 },
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
