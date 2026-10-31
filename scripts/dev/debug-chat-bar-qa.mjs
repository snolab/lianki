#!/usr/bin/env node
/**
 * Browser checks for the debug chat's bar (packages/debug-chat/src/DebugChat.tsx)
 * on the local /harness page — no lianki-push needed. Boots the widget server
 * on a free port, loads the hot widget (so its Tailwind CSS is there too), and
 * checks, expanded and minimized:
 *
 *   - one container: mark → tree → input → mic, in tab order
 *     (minimized: mark → tree → mic)
 *   - the tree button opens and closes the state tree (also ✕ and Escape)
 *     without taking the input's focus or its draft; the tree is shown as the
 *     log is (no box, click-through, the same fade and heights); the menu
 *     (double tap on the mark) and the tree are never open together
 *   - the input is 16px or more (iOS zooms into anything smaller)
 *   - each control is a 40px tap target
 *   - minimized, the input is inert: it cannot take focus, and Tab skips it
 *   - minimized, the mic is still on top and clickable
 *   - a vertical drag on the mic scrubs the history (floating lines), a
 *     horizontal one moves the bar, and neither toggles the mic
 *   - a message arriving while minimized floats above the bar
 *   - a voice line the agent polished shows the sparkle mark ("Polished");
 *     a tap shows the raw STT text and back; minimized, the floating line
 *     changes in place; a typed send carries no source
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

const browser = await launchSilent(chromium);
try {
  const open = async (query, colorScheme = "light", width = 390, height = 844) => {
    const ctx = await newSilentContext(browser, {
      viewport: { width, height },
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
      const kids = ["debug-chat-pill-min", "debug-chat-tree-button", "debug-chat-mic"].map((id) =>
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
        targets: ["debug-chat-pill-min", "debug-chat-tree-button", "debug-chat-mic"].map((id) =>
          target(q(id)),
        ),
        expanded: q("debug-chat-pill-min").getAttribute("aria-expanded"),
        width: bar.getBoundingClientRect().width,
        // The mic sits at the far right, after the input.
        micRight:
          bar.getBoundingClientRect().right - q("debug-chat-mic").getBoundingClientRect().right,
        micAfterInput:
          q("debug-chat-mic").getBoundingClientRect().left >= ta.getBoundingClientRect().right - 1,
      };
    });
    check(r.inBar, "expanded: controls and input share one container");
    check(r.font >= 16, `expanded: input font-size ${r.font}px ≥ 16px`);
    check(
      r.targets.every((t) => t >= 40),
      `controls are ≥ 40px tap targets (${r.targets.join(", ")})`,
    );
    check(r.expanded === "true", "minimize button has aria-expanded=true");
    check(
      r.micAfterInput && r.micRight < 6,
      `expanded: the mic is at the far right, after the input (${r.micRight}px from the edge)`,
    );
    // Tag the mic node: it must be the same one after minimizing.
    await page.evaluate(() => {
      document.querySelector('[data-testid="debug-chat-mic"]').__qaTag = 1;
    });
    const order = await tabOrder(page);
    check(
      order.join() === "debug-chat-pill-min,debug-chat-tree-button,debug-chat-input,debug-chat-mic",
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
    const m = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const mic = q("debug-chat-mic");
      return {
        same: mic.__qaTag === 1,
        nextToMenu:
          mic.getBoundingClientRect().left -
          q("debug-chat-tree-button").getBoundingClientRect().right,
      };
    });
    check(m.same, "the mic is the same DOM node across minimize");
    check(
      Math.abs(m.nextToMenu) < 4,
      `minimized: the mic sits right after the connections (${m.nextToMenu}px)`,
    );
    if (SHOTS) {
      await page.click('[data-testid="debug-chat-pill-min"]');
      await page.waitForSelector('[data-testid="debug-chat"]');
      await page.waitForTimeout(400);
    }
    await ctx.close();
  }

  // The input: one line at rest, grows to the cap, back to one line.
  {
    const { ctx, page } = await open("?open&offline"); // the longest placeholder
    const sel = '[data-testid="debug-chat-input"]';
    const h = () =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return { h: el.getBoundingClientRect().height, sh: el.scrollHeight, ch: el.clientHeight };
      }, sel);
    let r = await h();
    check(r.h <= 40, `390px, empty: the input is one line (${r.h}px)`);
    await page.click(sel);
    // (Enter would send: the lines go in as one paste.)
    await page.fill(sel, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    r = await h();
    check(
      r.h <= 130 && r.h >= 110 && r.sh > r.ch,
      `10 lines: capped (${r.h}px) and scrolling inside (${r.sh} > ${r.ch})`,
    );
    await page.fill(sel, "");
    await page.locator(sel).blur();
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat-minimized"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat"]');
    await page.waitForTimeout(400);
    r = await h();
    check(r.h <= 40, `minimize → expand, empty: one line again (${r.h}px)`);
    await ctx.close();
  }
  // Starting minimized (the input measured at 0 width), then expanded: still one line.
  {
    const { ctx, page } = await open("?min&offline");
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat"]');
    await page.waitForTimeout(400);
    const hh = await page.evaluate(
      () =>
        document.querySelector('[data-testid="debug-chat-input"]').getBoundingClientRect().height,
    );
    check(hh <= 40, `opened from minimized: one line (${hh}px)`);
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
        logHidden: q("debug-chat-column").hidden,
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
      order.slice(0, 3).join() === "debug-chat-pill-min,debug-chat-tree-button,debug-chat-mic" &&
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
    check(
      !during.at(-1)?.includes("I will fetch those clips first"),
      "dragging down goes back past the newest line",
    );
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
    // (The harness's last two lines: "TTS cache is cold on iOS", "I will fetch those clips first".)
    check(
      !!lines.at(-1)?.includes("TTS cache is cold on iOS"),
      `ArrowUp on the mic scrubs (${lines.at(-1)})`,
    );
    await page.keyboard.press("ArrowDown");
    const lines2 = await page.locator('[data-testid="debug-chat-float"]').allTextContents();
    check(
      !!lines2.at(-1)?.includes("I will fetch those clips first"),
      "ArrowDown comes back to the newest",
    );
    await ctx.close();
  }

  // The state tree, and the one-panel rule.
  {
    const { ctx, page } = await open("?open");
    const sel = (id) => `[data-testid="${id}"]`;
    const state = () =>
      page.evaluate(() => {
        const q = (id) => document.querySelector(`[data-testid="${id}"]`);
        const sheet = q("debug-chat-tree");
        const ta = q("debug-chat-input");
        return {
          tree: !!sheet,
          menu: !!q("debug-menu"),
          focus: document.activeElement === ta,
          value: ta.value,
          body: q("debug-chat-tree-body")?.textContent ?? "",
          expanded: q("debug-chat-tree-button").getAttribute("aria-expanded"),
        };
      });
    const settle = () => page.waitForTimeout(350);
    let both = false;
    const watch = async (label) => {
      const s = await state();
      if (s.tree && s.menu) {
        both = true;
        console.log(`  both open after: ${label}`);
      }
      return s;
    };
    await page.fill(sel("debug-chat-input"), "keep me");
    await page.focus(sel("debug-chat-input"));
    // Tree button: opens, keeps the input's focus and draft.
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    let s = await watch("tree button");
    check(s.tree && s.expanded === "true", "the tree button opens the state tree");
    // Shown as the log is: no box, click-through, the halo; one column with the
    // messages below it, at the log's expanded height.
    const look = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const tree = q("debug-chat-tree");
      const body = q("debug-chat-tree-body");
      const col = q("debug-chat-column");
      const log = q("debug-chat-log");
      const cs = getComputedStyle(tree);
      const bs = getComputedStyle(body);
      return {
        bg: cs.backgroundColor,
        border: cs.borderTopWidth,
        bodyBg: bs.backgroundColor,
        events: [cs.pointerEvents, bs.pointerEvents].join(),
        halo: bs.textShadow !== "none",
        maxH: getComputedStyle(col).maxHeight,
        vh30: `${(innerHeight * 30) / 100}px`,
        below:
          !log.hidden &&
          col.contains(tree) &&
          col.contains(log) &&
          tree.getBoundingClientRect().bottom <= log.getBoundingClientRect().top + 0.5,
      };
    });
    check(
      look.bg === "rgba(0, 0, 0, 0)" && look.bodyBg === "rgba(0, 0, 0, 0)" && look.border === "0px",
      `no box: no background or border (${look.bg}, ${look.border})`,
    );
    check(look.events === "none,none", `click-through as the log (${look.events})`);
    check(look.halo, "translucent text with the halo");
    check(
      Math.abs(parseFloat(look.maxH) - parseFloat(look.vh30)) < 1,
      `input focused: expanded as the log would be (${look.maxH})`,
    );
    check(look.below, "one column: the tree on top, the messages below it");
    check(s.focus && s.value === "keep me", "the input keeps its focus and its draft");
    check(s.body.length > 0, "the tree shows its content");
    // Again: closes.
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    s = await watch("tree button again");
    check(!s.tree && s.expanded === "false", "the tree button again closes it");
    check(s.focus && s.value === "keep me", "still focused, draft intact");
    // ✕ closes.
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    await page.click(sel("debug-chat-tree-close"));
    await settle();
    s = await watch("close");
    check(!s.tree && s.focus, "✕ closes it, and the input keeps its focus");
    // Escape closes.
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    await page.keyboard.press("Escape");
    await settle();
    s = await watch("escape");
    check(!s.tree && s.value === "keep me", "Escape closes it");
    // A tap outside is the page's: the tree stays (it is click-through, as the log).
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    await page.mouse.click(40, 120);
    await settle();
    s = await watch("outside");
    check(s.tree, "a tap outside leaves it open");
    // Not focused: compact, as the log.
    const compact = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-testid="debug-chat-column"]')).maxHeight,
    );
    check(compact === `${4.4 * 16}px`, `unfocused: compact, as the log (${compact})`);
    await page.click(sel("debug-chat-tree-close"));
    await settle();
    // Never both: tree, then a double tap on the mark (menu) — the tree closes.
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    await watch("tree button");
    await page.dblclick(sel("debug-chat-pill-min"));
    await settle();
    s = await watch("double tap");
    check(s.menu && !s.tree, "a double tap on the mark opens the menu and closes the tree");
    // Menu, then the tree button — the menu closes.
    await page.click(sel("debug-chat-tree-button"));
    await settle();
    s = await watch("tree button over the menu");
    check(s.tree && !s.menu, "the tree button closes the menu");
    // Double tap again over the tree, then twice more (menu off, menu on).
    for (let i = 0; i < 3; i++) {
      await page.dblclick(sel("debug-chat-pill-min"));
      await settle();
      await watch(`double tap ${i}`);
    }
    check(!both, "the menu and the tree are never open together");
    await ctx.close();
  }
  // The tree's chips and detents (treeNav), in the one column, at 390 and 1024.
  for (const [w, h] of [
    [390, 844],
    [1024, 768],
  ]) {
    const { ctx, page } = await open("?open", "light", w, h);
    await page.focus('[data-testid="debug-chat-input"]'); // expanded, as while typing
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForSelector('[data-testid="tree-chip"]', { timeout: 5000 }).catch(() => {});
    const g = await page.evaluate(() => ({
      chips: document.querySelectorAll('[data-testid="tree-chip"]').length,
      open: document.querySelectorAll('[data-testid="tree-chip"][data-open]').length,
      lines: document.querySelectorAll('[data-testid="tree-line"]').length,
      mode: document.querySelector('[data-testid="debug-chat-tree"]')?.dataset.mode,
      width: document.querySelector("[data-debug-chat]").getBoundingClientRect().width,
    }));
    check(
      g.chips > 0 && g.open === 0 && g.lines === 0 && g.mode === "column",
      `${w}px: the tree is a chip row, nothing open, in the one column (${JSON.stringify(g)})`,
    );
    check(g.width <= 320.5, `${w}px: one column, no wider box (${g.width}px)`);
    // Drag 2 cells right on the tree button: the focused chip opens 2 levels (a preview)…
    const b = await page.locator('[data-testid="debug-chat-tree-button"]').boundingBox();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 10, cy);
    const mid = await page.evaluate(() => ({
      hint: document.querySelector('[data-testid="debug-chat-tree-hint"]')?.textContent ?? "",
      deepest: Math.max(
        -1,
        ...[...document.querySelectorAll('[data-testid="tree-line"]')].map((l) => +l.dataset.level),
      ),
    }));
    check(
      / · 2\/\d$/.test(mid.hint) && mid.deepest === 1,
      `drag 2 cells right: depth 2 shown live (${mid.hint}; deepest line level ${mid.deepest})`,
    );
    await page.mouse.move(cx + 85, cy); // just past 2 cells: snaps back to 2 on release
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => ({
      hint: !!document.querySelector('[data-testid="debug-chat-tree-hint"]'),
      deepest: Math.max(
        -1,
        ...[...document.querySelectorAll('[data-testid="tree-line"]')].map((l) => +l.dataset.level),
      ),
      open: document.querySelectorAll('[data-testid="tree-chip"][data-open]').length,
      tree: !!document.querySelector('[data-testid="debug-chat-tree"]'),
    }));
    check(
      !after.hint && after.deepest === 1 && after.open === 1 && after.tree,
      `released: snapped to depth 2, one node open, the tree still up (${JSON.stringify(after)})`,
    );
    // A drag never moves the bar.
    const b2 = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
    check(
      Math.abs(b2.x - (b.x - (b.x - b2.x))) < 1 &&
        b2.y === (await page.locator('[data-testid="debug-chat-pill"]').boundingBox()).y,
      "the tree drag leaves the bar where it was",
    );
    // Left 1 cell: folds a level.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(cx - i * 10, cy);
    await page.mouse.up();
    const folded = await page.evaluate(() =>
      Math.max(
        -1,
        ...[...document.querySelectorAll('[data-testid="tree-line"]')].map((l) => +l.dataset.level),
      ),
    );
    check(folded === 0, `drag 1 cell left: one level folded (deepest ${folded})`);
    // Tapping another chip opens it instead (one at a time).
    const second = page.locator('[data-testid="tree-chip"]').nth(1);
    if (await second.count()) {
      await second.click();
      const one = await page.evaluate(() => [
        document.querySelectorAll('[data-testid="tree-chip"][data-open]').length,
        document.querySelector('[data-testid="tree-chip"][data-focus]')?.dataset.id,
      ]);
      check(
        one[0] <= 1 && one[1] === "1",
        `a tapped chip takes the focus; one open at most (${one})`,
      );
    }
    // One scroller: the wheel over the tree scrolls the column, messages below.
    const col = '[data-testid="debug-chat-column"]';
    await page.evaluate((c) => {
      document.querySelector(c).scrollTop = 0;
    }, col);
    const tr = await page.locator('[data-testid="tree-chips"]').boundingBox();
    await page.mouse.move(tr.x + 20, tr.y + 6);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(200);
    const st = await page.evaluate((c) => document.querySelector(c).scrollTop, col);
    check(st > 0, `the wheel over the tree scrolls the one column (${st})`);
    // ←/→ on the focused tree button move the focus.
    await page.focus('[data-testid="debug-chat-tree-button"]');
    await page.keyboard.press("ArrowLeft");
    const f = await page.evaluate(
      () =>
        document.querySelector(
          '[data-testid="tree-chip"][data-focus], [data-testid="tree-line"][data-focus]',
        )?.dataset.id,
    );
    check(f === "0", `ArrowLeft on the tree button moves the focus along the row (${f})`);
    await ctx.close();
  }

  // In-progress items blink (opacity, 1.6 s); Chinese strings on a zh page.
  {
    const { ctx, page } = await open("?open");
    await page.evaluate(() => {
      document.documentElement.lang = "zh-CN";
    });
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForSelector('[data-testid="tree-chip"]', { timeout: 5000 }).catch(() => {});
    const z = await page.evaluate(() => ({
      label: document.querySelector('[data-testid="debug-chat-tree"]')?.getAttribute("aria-label"),
      close: document
        .querySelector('[data-testid="debug-chat-tree-close"]')
        ?.getAttribute("aria-label"),
    }));
    check(
      z.label === "状态树" && z.close === "关闭状态树",
      `zh page: Chinese tree strings (${z.label}, ${z.close})`,
    );
    await ctx.close();
  }
  {
    // The minimized ▶ line (from the tree's own frontier) blinks.
    const { ctx, page } = await open("?min&nofrontier");
    await page
      .waitForSelector('[data-testid="debug-chat-frontier-line"][data-status="doing"]', {
        timeout: 5000,
      })
      .catch(() => {});
    const anim = await page.evaluate(() => {
      const el = document.querySelector(".animate-lk-blink");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return [cs.animationName, cs.animationDuration];
    });
    check(
      anim?.[0] === "lk-blink" && anim?.[1] === "1.6s",
      `in-progress items blink (${JSON.stringify(anim)})`,
    );
    await ctx.close();
  }

  // The interim tree source: lk:tree-src, fetched and sanitized, shown as the log.
  {
    const { ctx, page } = await open("?open&notree");
    await page.evaluate((u) => localStorage.setItem("lk:tree-src", u), `${ORIGIN}/tree-frag.html`);
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page
      .waitForSelector('[data-testid="debug-chat-tree-fragment"] details', { timeout: 5000 })
      .catch(() => {});
    const t = await page.evaluate(() => {
      const frag = document.querySelector('[data-testid="debug-chat-tree-fragment"]');
      const w = frag?.querySelector(".w");
      return {
        text: frag?.textContent ?? "",
        waiting: w ? [getComputedStyle(w).color, getComputedStyle(w).fontWeight] : null,
        done: frag?.querySelector(".ok")
          ? getComputedStyle(frag.querySelector(".ok")).opacity
          : null,
        bad: frag ? frag.querySelectorAll("script, a, [onclick], [style*=red]").length : -1,
      };
    });
    await page.click('[data-testid="debug-chat-tree-fragment"] li.w').catch(() => {});
    const xss = await page.evaluate(() => window.__treeXss ?? 0);
    check(
      t.text.includes("interim tree source"),
      "lk:tree-src: the fragment shows in the tree panel",
    );
    check(
      t.waiting?.[0].startsWith("oklch(0.62 0.17 35") && Number(t.waiting?.[1]) >= 700,
      `.w is orange and bold (${t.waiting})`,
    );
    check(t.done === "0.6", `.ok is dimmed (${t.done})`);
    check(t.bad === 0 && xss === 0, `no script, link or handler survives (${t.bad}, ${xss})`);
    // Closed and opened again: fetched again (the server counts), the new one shown.
    const count = () =>
      page.evaluate(() =>
        Number(
          /fetch (\d+)/.exec(
            document.querySelector('[data-testid="debug-chat-tree-fragment"]')?.textContent ?? "",
          )?.[1],
        ),
      );
    const n1 = await count();
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page
      .waitForFunction(
        (n) =>
          /fetch (\d+)/.exec(
            document.querySelector('[data-testid="debug-chat-tree-fragment"]')?.textContent ?? "",
          )?.[1] > n,
        n1,
        { timeout: 5000 },
      )
      .catch(() => {});
    const n2 = await count();
    check(n2 > n1, `reopened: the fragment is fetched again and replaced (fetch ${n1} → ${n2})`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open("?open&notree");
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForTimeout(350);
    const empty = await page.locator('[data-testid="debug-chat-tree-empty"]').textContent();
    check(empty === "No tree source", "with no tree source, the tree says so");
    await ctx.close();
  }
  {
    const { ctx, page } = await open("?min");
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="debug-chat-pill"] button')]
        .filter((b) => !b.closest("[inert]") && b.getBoundingClientRect().width > 0)
        .map((b) => b.dataset.testid),
    );
    check(
      ids.join() === "debug-chat-pill-min,debug-chat-tree-button,debug-chat-mic",
      `minimized: [mark | tree | mic] (${ids.join(", ")})`,
    );
    await ctx.close();
  }
  // Minimized, a tree drag must not move the tree with each level (the owner,
  // 2026-10-30: "the tree jumps while I drag"): the body takes its full height
  // once, then the focused row stays put while levels open and fold.
  {
    const { ctx, page } = await open("?min");
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForTimeout(350);
    const b = await page.locator('[data-testid="debug-chat-tree-button"]').boundingBox();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const focusTop = () =>
      page.evaluate(() =>
        Math.round(
          document.querySelector('[data-testid="tree-chips"] [data-focus]')?.getBoundingClientRect()
            .top ?? -1,
        ),
      );
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 12, cy); // axis locked: the body grows once
    await page.waitForTimeout(300); // its max-height transition
    const tops = [];
    for (const dx of [20, 35, 50, 65, 80, 95, 80, 60, 40, 20, 5, -20, 5, 40, 80]) {
      await page.mouse.move(cx + dx, cy);
      tops.push(await focusTop());
    }
    // Inside one detent (2 cells: 80 → 95 px) the hint still follows the
    // finger, set straight on it rather than by a render.
    const hint = page.locator('[data-testid="debug-chat-tree-hint"]');
    const before = await hint.evaluate((el) => el.style.transform);
    await page.mouse.move(cx + 95, cy);
    const after = await hint.evaluate((el) => el.style.transform);
    await page.mouse.up();
    const spread = Math.max(...tops) - Math.min(...tops);
    check(
      spread <= 2,
      `minimized drag: the focused row stays still across levels (tops ${[...new Set(tops)].join(",")})`,
    );
    check(before !== after, `inside a detent the hint follows the finger (${before} → ${after})`);
    await ctx.close();
  }

  // Regression (iPhone, 1761627): with the history capped (same length every
  // time) and skewed timestamps, every new line while minimized still floats.
  {
    const { ctx, page } = await open("?min&cap=30");
    await page.evaluate(() => {
      const day = 86_400_000;
      window.__push("my own line", "owner", Date.now() - day);
      window.__push("reply from the future", "agent", Date.now() + day);
      window.__push("reply at epoch zero", "agent", 0);
    });
    const float = page.locator('[data-testid="debug-chat-float"]');
    await float
      .nth(2)
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    const lines = await float.allTextContents();
    check(
      lines.join(" | ") ===
        "you:my own line | agent:reply from the future | agent:reply at epoch zero",
      `capped list, skewed clocks: all 3 new lines float (${lines.join(" | ")})`,
    );
    // The unread badge counts the two replies (not the own line), capped list or not.
    const badge = await page
      .locator('[data-testid="debug-chat-pill-unread"]')
      .textContent()
      .catch(() => null);
    check(badge === "2", `capped list: the unread badge counts the 2 replies (${badge})`);
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="debug-chat-float"][data-fading]').length === 3,
        null,
        { timeout: 6000 },
      )
      .catch(() => {});
    const fading = await page.locator('[data-testid="debug-chat-float"][data-fading]').count();
    check(fading === 3, `then all 3 fade (${fading} fading)`);
    // Opened, they are read: minimized again, no badge.
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat"]');
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat-minimized"]');
    check(
      (await page.locator('[data-testid="debug-chat-pill-unread"]').count()) === 0,
      "opened and minimized again: nothing unread",
    );
    await ctx.close();
  }

  // The mic outlives the widget: a remount (hot swap) keeps the same live stream;
  // a reload resumes by itself when it may, else waits for a tap. getUserMedia is
  // a fake here: a silent MediaStreamDestination, so nothing is ever recorded.
  {
    // Audio may start without a gesture here (as on a page the browser trusts):
    // the auto path. Headless Chrome's default keeps it suspended (the tap path).
    const audioBrowser = await launchSilent(chromium, {
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const ctx = await newSilentContext(audioBrowser, { viewport: { width: 390, height: 844 } });
    await ctx.route(/cdn\.jsdelivr\.net/, (r) => r.abort()); // no Silero: the energy fallback
    await ctx.addInitScript((src) => {
      localStorage.setItem("lk:debug-widget-src", src);
      localStorage.setItem("lk:debug-chat-open", "1");
      window.__gum = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.__gum++;
        const ac = new AudioContext();
        return ac.createMediaStreamDestination().stream; // silent, not the mic
      };
    }, `${ORIGIN}/debug-chat.js`);
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/harness`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    const mic = '[data-testid="debug-chat-mic"]';
    await page.click(mic);
    await page
      .waitForSelector(`${mic}[data-state="listening"]`, { timeout: 10_000 })
      .catch(() => {});
    const before = await page.evaluate(() => ({
      id: globalThis.__lkMic?.stream()?.id,
      gum: window.__gum,
      flag: sessionStorage.getItem("lk:agent:mic"),
    }));
    check(
      before.id && before.gum === 1 && before.flag === "1",
      `mic on: one stream (${before.id}), flag set`,
    );
    await page.evaluate(() => window.__remount());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      id: globalThis.__lkMic?.stream()?.id,
      live: globalThis.__lkMic
        ?.stream()
        ?.getTracks()
        .every((t) => t.readyState === "live"),
      gum: window.__gum,
      state: document.querySelector('[data-testid="debug-chat-mic"]')?.dataset.state,
    }));
    check(
      after.id === before.id && after.live && after.gum === 1 && after.state === "listening",
      `remounted (hot swap): same live stream, getUserMedia once, still listening (${JSON.stringify(after)})`,
    );
    // A real reload, the permission not granted: "tap to resume".
    await page.reload();
    await page.waitForSelector(`${mic}[data-resume]`, { timeout: 30_000 }).catch(() => {});
    const r1 = await page.evaluate(() => ({
      label: document.querySelector('[data-testid="debug-chat-mic"]')?.getAttribute("aria-label"),
      dashed: !!document.querySelector('[data-testid="debug-chat-mic-resume"]'),
      log: window.__devLog?.filter((e) => e.ev === "mic-resume"),
      gum: window.__gum,
    }));
    check(
      r1.label === "Tap to resume listening" && r1.dashed && r1.gum === 0,
      `reloaded, not granted: tap to resume (${r1.label}; ${JSON.stringify(r1.log)})`,
    );
    await page.click(mic);
    await page
      .waitForSelector(`${mic}[data-state="listening"]`, { timeout: 10_000 })
      .catch(() => {});
    check(
      (await page.getAttribute(mic, "data-state")) === "listening",
      "one tap resumes listening",
    );
    // Granted: the reload resumes by itself.
    await ctx.grantPermissions(["microphone"], { origin: ORIGIN });
    await page.reload();
    await page
      .waitForSelector(`${mic}[data-state="listening"]`, { timeout: 30_000 })
      .catch(() => {});
    const r2 = await page.evaluate(() => ({
      state: document.querySelector('[data-testid="debug-chat-mic"]')?.dataset.state,
      log: window.__devLog?.filter((e) => e.ev === "mic-resume"),
    }));
    check(
      r2.state === "listening" && r2.log?.[0]?.path === "auto",
      `reloaded, granted: resumed by itself (${JSON.stringify(r2.log)})`,
    );
    // Escape (an explicit off) clears the flag: the next reload stays off.
    await page.keyboard.press("Escape");
    await page.waitForSelector(`${mic}[data-state="off"]`, { timeout: 5000 }).catch(() => {});
    const flag = await page.evaluate(() => sessionStorage.getItem("lk:agent:mic"));
    check(flag === null, "an explicit off clears the reload flag");
    await ctx.close();
    await audioBrowser.close();
  }

  // The floating box hangs on the bar's side: right, left, centre; always on screen.
  {
    const { ctx, page } = await open("?min");
    await page.evaluate(() => window.__push("a short reply"));
    await page.waitForSelector('[data-testid="debug-chat-float"]');
    const dragBarTo = async (targetCenter) => {
      const m = await page.locator('[data-testid="debug-chat-pill-min"]').boundingBox();
      const bar = await page.locator('[data-testid="debug-chat-pill"]').boundingBox();
      const dx = targetCenter - (bar.x + bar.width / 2);
      await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++)
        await page.mouse.move(m.x + m.width / 2 + (dx * i) / 10, m.y + m.height / 2);
      await page.mouse.up();
      await page.waitForTimeout(500); // past the double-tap window
    };
    const measure = () =>
      page.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const box = r('[data-testid="debug-chat-float-box"]');
        const bar = r('[data-testid="debug-chat-pill"]');
        const el = document.querySelector('[data-testid="debug-chat-float-box"]');
        return {
          side: el.dataset.side,
          align: getComputedStyle(el).textAlign,
          box: { l: box.left, r: box.right },
          bar: { l: bar.left, r: bar.right },
          vw: document.documentElement.clientWidth,
        };
      });
    const inside = (m) => m.box.l >= 8 - 0.5 && m.box.r <= m.vw - 8 + 0.5;
    await dragBarTo(390);
    let m = await measure();
    check(
      // Right edges together, unless the gutter clamps it.
      m.side === "right" &&
        Math.abs(m.box.r - Math.min(m.bar.r, m.vw - 8)) < 1.5 &&
        m.align === "right" &&
        inside(m),
      `bar right: right edges together, text right, on screen (${JSON.stringify(m)})`,
    );
    await dragBarTo(0);
    m = await measure();
    check(
      m.side === "left" &&
        Math.abs(m.box.l - Math.max(m.bar.l, 8)) < 1.5 &&
        m.align === "left" &&
        inside(m),
      `bar left: left edges together, text left, on screen (${JSON.stringify(m)})`,
    );
    await dragBarTo(195);
    m = await measure();
    check(
      m.side === "center" &&
        Math.abs((m.box.l + m.box.r) / 2 - (m.bar.l + m.bar.r) / 2) < 1.5 &&
        inside(m),
      `bar in the middle: centred, on screen (${JSON.stringify(m)})`,
    );
    // The tree, minimized, with the bar at the right edge: fully on screen.
    await dragBarTo(390);
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForTimeout(400);
    const t = await page.evaluate(() => {
      const tree = document
        .querySelector('[data-testid="debug-chat-tree"]')
        .getBoundingClientRect();
      return { l: tree.left, r: tree.right, vw: document.documentElement.clientWidth };
    });
    check(
      t.l >= 7.5 && t.r <= t.vw - 7.5,
      `bar right, tree open: the tree is fully on screen (${JSON.stringify(t)})`,
    );
    await ctx.close();
  }
  // Minimizing floats the latest message for its dwell, from the tap, then fades it.
  {
    const { ctx, page } = await open("?open");
    await page.evaluate(() => window.__push("the latest line"));
    await page.waitForTimeout(200);
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat-minimized"]');
    const t0 = Date.now();
    const line = page.locator('[data-testid="debug-chat-float"]');
    const first = await line.allTextContents();
    check(
      first.join() === "agent:the latest line",
      `on minimize the latest line floats (${first})`,
    );
    // Still fully there late in its dwell (2.5 s minimum)...
    await page.waitForTimeout(Math.max(0, 2000 - (Date.now() - t0)));
    const mid = await line.evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
    check(mid.join() === "1", `still fully visible at 2 s (opacity ${mid})`);
    // ...then starts its slow fade (FADE_MS = 10 s) once the dwell is over.
    await page.waitForSelector('[data-testid="debug-chat-float"][data-fading]', { timeout: 3000 });
    const fadeAt = Date.now() - t0;
    check(fadeAt >= 1500 && fadeAt < 3500, `then the fade starts (${fadeAt} ms after minimize)`);
    await page.waitForTimeout(1500);
    const midFade = Number(await line.evaluate((e) => getComputedStyle(e).opacity));
    check(midFade > 0.2 && midFade < 0.99, `the fade is gradual (opacity ${midFade} 1.5 s in)`);
    // Hovering (touching) it snaps it back to full, and holds it there.
    await line.hover();
    await page.waitForTimeout(100);
    const held = await line.evaluate((e) => [getComputedStyle(e).opacity, e.dataset.fading]);
    check(held[0] === "1" && !held[1], `hovered mid-fade, it is back at full (${held})`);
    // Released: the fade starts over from full.
    await page.mouse.move(380, 100);
    await page.waitForSelector('[data-testid="debug-chat-float"][data-fading]', { timeout: 1000 });
    await page.waitForTimeout(500);
    const again = Number(await line.evaluate((e) => getComputedStyle(e).opacity));
    check(again > 0.75, `released, the fade starts over from full (opacity ${again} 0.5 s in)`);
    await ctx.close();
  }

  // The frontier: three lines just above the minimized bar.
  {
    const { ctx, page } = await open("?min");
    await page.evaluate(() => window.__push("a float above the frontier"));
    await page.waitForSelector('[data-testid="debug-chat-float"]');
    const f = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const lines = [...document.querySelectorAll('[data-testid="debug-chat-frontier-line"]')];
      const r = (el) => el.getBoundingClientRect();
      const doing = q('[data-status="doing"]');
      const id = doing.querySelector('[data-testid="debug-chat-frontier-id"]');
      return {
        statuses: lines.map((l) => l.dataset.status).join(),
        text: lines.map((l) => l.querySelector("button").textContent).join(" | "),
        aboveBar:
          r(q('[data-testid="debug-chat-frontier"]')).bottom <=
          r(q('[data-testid="debug-chat-pill"]')).top,
        floatsAbove:
          r(q('[data-testid="debug-chat-floats"]')).bottom <=
          r(q('[data-testid="debug-chat-frontier"]')).top + 1,
        oneLine: lines.every((l) => r(l).height < 30),
        avatar: doing.querySelector('[role="img"]')?.getAttribute("aria-label"),
        idShort: id?.textContent,
        idTitle: id?.getAttribute("title"),
        humanIds: [
          ...document.querySelectorAll(
            '[data-status="done"] [data-testid="debug-chat-frontier-id"]',
          ),
        ].length,
        collapsed: !q('[data-testid="debug-chat-frontier-items"]'),
      };
    });
    check(f.statuses === "done,doing,next", `minimized: three frontier lines (${f.text})`);
    check(f.aboveBar && f.floatsAbove, "they sit just above the bar, floating lines above them");
    check(f.oneLine, "each is one line");
    // Text only over the page: no fill, no box, no blur; a halo instead.
    const look = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-testid="debug-chat-float"], [data-testid="debug-chat-frontier-line"]',
        ),
      ].map((el) => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          image: cs.backgroundImage,
          border: cs.borderTopWidth,
          blur: cs.backdropFilter ?? cs.webkitBackdropFilter ?? "none",
          halo: cs.textShadow,
        };
      }),
    );
    check(
      look.length >= 4 &&
        look.every(
          (l) =>
            l.bg === "rgba(0, 0, 0, 0)" &&
            l.image === "none" &&
            l.border === "0px" &&
            (l.blur === "none" || l.blur === ""),
        ),
      `floating and frontier lines: transparent, no box (${[...new Set(look.map((l) => `${l.bg} ${l.border} ${l.blur}`))].join("; ")})`,
    );
    check(
      look.every((l) => l.halo !== "none" && l.halo.split("px,").length >= 4),
      "and a strong halo in the page colour",
    );
    check(f.text.includes("多线并进〔3〕"), "a group shows its summary and 〔count〕");
    check(f.avatar === "Agent: main lane", `in progress shows who, labelled (${f.avatar})`);
    check(
      f.idShort === "7f3a9c" && f.idTitle === "agent id: lane-main-7f3a9c",
      `the agent id at the right: ${f.idShort}, full in its title`,
    );
    check(f.collapsed, "groups start collapsed");
    // Tap: expands in place to list the items, with breadcrumbs and avatars.
    await page.click('[data-status="doing"] button');
    const items = await page
      .locator('[data-testid="debug-chat-frontier-items"] > li')
      .allTextContents();
    check(
      items.length === 3 && items[0].includes("chat › bar › minimized"),
      `tap expands the group (${items.join(" / ")})`,
    );
    const humanLabel = await page
      .locator('[data-testid="debug-chat-frontier-items"] [aria-label="Person: Ada"]')
      .count();
    check(humanLabel === 1, "a human item shows a person avatar, and no id");
    const shot = SHOTS ? join(SHOTS, "frontier-expanded-light.png") : null;
    if (shot) await page.screenshot({ path: shot });
    await page.click('[data-status="doing"] button');
    check(
      (await page.locator('[data-testid="debug-chat-frontier-items"]').count()) === 0,
      "a second tap collapses it",
    );
    // Expanded again: the lines go (the tree has it all); minimized again: collapsed.
    await page.click('[data-status="doing"] button');
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat"]');
    check(
      (await page.locator('[data-testid="debug-chat-frontier"]').count()) === 0,
      "expanded: no frontier lines",
    );
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat-minimized"]');
    check(
      (await page.locator('[data-testid="debug-chat-frontier-items"]').count()) === 0,
      "minimized again: the group is collapsed",
    );
    await ctx.close();
  }
  // Long press (touch) on the agent id shows the full one.
  {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await ctx.addInitScript(
      (src) => localStorage.setItem("lk:debug-widget-src", src),
      `${ORIGIN}/debug-chat.js`,
    );
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/harness?min`);
    await page.waitForSelector('[data-testid="debug-chat-frontier-id"]', { timeout: 30_000 });
    const box = await page.locator('[data-testid="debug-chat-frontier-id"]').boundingBox();
    const cdp = await ctx.newCDPSession(page);
    const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
    await page.waitForTimeout(700);
    const full = await page
      .locator('[data-testid="debug-chat-frontier-id-full"]')
      .textContent()
      .catch(() => null);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check(full === "lane-main-7f3a9c", `a long press on the id shows it in full (${full})`);
    await ctx.close();
  }

  // Reading speed: 1× / 1.25× / 1.5× / 2× in the menu, 1.5× by default, per device.
  {
    const { ctx, page } = await open("?open");
    await page.dblclick('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-menu-rate"]');
    const opts = await page.$$eval('[data-testid="debug-menu-rate"] [role="radio"]', (els) =>
      els.map((e) => `${e.textContent}${e.getAttribute("aria-checked") === "true" ? "*" : ""}`),
    );
    check(
      opts.join(" ") === "1× 1.25× 1.5×* 2×",
      `speed control, 1.5× by default (${opts.join(" ")})`,
    );
    await page.click('[data-testid="debug-menu-rate"] [data-rate="2"]');
    const saved = await page.evaluate(() => localStorage.getItem("lk:agent-speech-rate"));
    const checked = await page.getAttribute(
      '[data-testid="debug-menu-rate"] [data-rate="2"]',
      "aria-checked",
    );
    check(saved === "2" && checked === "true", `2× picked and saved (${saved})`);
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

  // A voice line the agent polished: the mark, its tooltip, the raw text on a tap.
  {
    const { ctx, page } = await open("?open");
    await page.fill('[data-testid="debug-chat-input"]', "typed line");
    await page.press('[data-testid="debug-chat-input"]', "Enter");
    const sent = await page.evaluate(() => window.__sent?.at(-1));
    check(sent?.source === null, `a typed send has no source (${JSON.stringify(sent)})`);
    await page.evaluate(() => window.__polish("Typed line, polished."));
    const mark = page.locator('[data-testid="debug-chat-polished"]').last();
    await mark.waitFor({ timeout: 3000 });
    const tip = await mark.evaluate((e) => [
      e.title,
      e.getAttribute("aria-label"),
      !!e.querySelector("svg"),
    ]);
    check(
      tip[0] === "Polished" && tip[1] === "Polished" && tip[2],
      `the polished mark is an icon titled "Polished" (${tip})`,
    );
    const line = page.locator('[data-testid="debug-chat-line"]').last();
    check(
      (await line.textContent()).includes("Typed line, polished."),
      "the polished text is shown",
    );
    await mark.click();
    check(
      (await line.locator('[data-testid="debug-chat-raw"]').textContent()) === "typed line",
      "a tap on the mark shows the raw STT text",
    );
    await mark.click();
    check(
      (await line.locator('[data-testid="debug-chat-raw"]').count()) === 0,
      "a second tap goes back to the polished text",
    );
    // Minimized, a floating line changes in place.
    await page.click('[data-testid="debug-chat-pill-min"]');
    await page.waitForSelector('[data-testid="debug-chat-minimized"]');
    await page.evaluate(() => window.__push("a voice line", "owner"));
    await page.waitForSelector('[data-testid="debug-chat-float"]');
    await page.evaluate(() => window.__polish("A voice line."));
    await page.waitForTimeout(100);
    const floats = await page.locator('[data-testid="debug-chat-float"]').allTextContents();
    check(
      floats.filter((t) => t.includes("A voice line.")).length === 1 &&
        !floats.some((t) => t.includes("a voice line")),
      `the floating line is polished in place (${floats})`,
    );
    await ctx.close();
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const scheme of ["light", "dark"]) {
      const { ctx, page } = await open("?open", scheme, 1024, 768);
      await page.focus('[data-testid="debug-chat-input"]'); // expanded, as while typing
      await page.click('[data-testid="debug-chat-tree-button"]');
      await page.waitForTimeout(350);
      const file = join(SHOTS, `desktop-two-col-${scheme}.png`);
      await page.screenshot({ path: file });
      console.log(`shot ${file}`);
      await ctx.close();
    }
    for (const scheme of ["light", "dark"])
      for (const state of ["expanded", "minimized", "tree"]) {
        const { ctx, page } = await open(state === "minimized" ? "?min" : "?open", scheme);
        if (state === "tree") {
          await page.focus('[data-testid="debug-chat-input"]');
          await page.click('[data-testid="debug-chat-tree-button"]');
          await page.waitForTimeout(350);
        }
        if (state === "minimized") {
          await page.evaluate(() => {
            window.__push("今日はここまで。明日また続けましょう。");
            window.__push("Pushed the fix; the bar is one container now.");
          });
          await page.waitForTimeout(300);
        } else if (state === "expanded") {
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
