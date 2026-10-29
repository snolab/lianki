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
  const open = async (query, colorScheme = "light", width = 390, height = 844) => {
    const ctx = await browser.newContext({
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
    // Shown as the log is: no box, click-through, the halo, the log's expanded height.
    const look = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const tree = q("debug-chat-tree");
      const body = q("debug-chat-tree-body");
      const cs = getComputedStyle(tree);
      const bs = getComputedStyle(body);
      return {
        bg: cs.backgroundColor,
        border: cs.borderTopWidth,
        bodyBg: bs.backgroundColor,
        events: [cs.pointerEvents, bs.pointerEvents].join(),
        halo: bs.textShadow !== "none",
        maxH: bs.maxHeight,
        vh30: `${(innerHeight * 30) / 100}px`,
        logHidden: q("debug-chat-log").hidden,
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
    check(look.logHidden, "390px: the tree takes the log's place");
    check(s.focus && s.value === "keep me", "the input keeps its focus and its draft");
    check(s.body.includes("chat"), "the sheet shows the tree from renderTree");
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
      () =>
        getComputedStyle(document.querySelector('[data-testid="debug-chat-tree-body"]')).maxHeight,
    );
    check(compact === `${4.1 * 16}px`, `unfocused: compact, as the log (${compact})`);
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
  // Phone width: the tree shows in the log's place.
  {
    const { ctx, page } = await open("?open");
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForTimeout(350);
    const mode = await page.getAttribute('[data-testid="debug-chat-tree"]', "data-mode");
    check(mode === "inline", `390px: the tree opens in the log's place (${mode})`);
    await ctx.close();
  }

  // Wide (1024): tree | log, side by side; switching back keeps the tree's scroll.
  {
    const { ctx, page } = await open("?open", "light", 1024, 768);
    // Focused: both columns expanded, as the log is while typing.
    await page.focus('[data-testid="debug-chat-input"]');
    await page.click('[data-testid="debug-chat-tree-button"]');
    await page.waitForTimeout(350);
    const g = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const r = (el) => el.getBoundingClientRect();
      const box = document.querySelector("[data-debug-chat]");
      const tree = q("debug-chat-tree");
      const log = q("debug-chat-log");
      const slot = q("debug-chat-input-slot");
      const bar = q("debug-chat-pill");
      return {
        two: box.hasAttribute("data-two-col"),
        mode: tree.dataset.mode,
        width: r(box).width,
        tree: r(tree),
        log: r(log),
        bar: r(bar),
        slot: r(slot),
        logVisible: getComputedStyle(log).display !== "none" && r(log).height > 100,
        boxless: getComputedStyle(box).backgroundColor === "rgba(0, 0, 0, 0)",
      };
    });
    check(g.two && g.mode === "column", `1024px: the tree is a column (${g.mode})`);
    check(g.width > 600, `1024px: the box widens (${g.width}px)`);
    check(g.boxless, "1024px: both columns are box-less log surfaces");
    check(
      g.logVisible && g.tree.right <= g.log.left + 1 && g.tree.width > 150,
      `tree | log side by side (tree ${Math.round(g.tree.left)}–${Math.round(g.tree.right)}, log ${Math.round(g.log.left)}–${Math.round(g.log.right)})`,
    );
    check(
      g.bar.left <= g.tree.left + 1 && g.bar.right >= g.log.right - 1 && g.slot.left < g.tree.right,
      "the bar and its input span both columns",
    );
    // Each column scrolls by itself.
    const scrolls = () =>
      page.evaluate(() => [
        document.querySelector('[data-testid="debug-chat-tree-body"]').scrollTop,
        document.querySelector('[data-testid="debug-chat-log"]').scrollTop,
      ]);
    const [, log0] = await scrolls();
    await page.mouse.move(g.tree.left + 60, g.tree.top + 120);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    const [t1, l1] = await scrolls();
    check(t1 > 0 && l1 === log0, `the tree scrolls on its own (tree ${t1}, log ${log0} → ${l1})`);
    // The log is click-through (only the input's swipe and the mic scroll it):
    // scroll it directly, and the tree stays put.
    await page.evaluate(() => {
      document.querySelector('[data-testid="debug-chat-log"]').scrollTop -= 200;
    });
    await page.waitForTimeout(100);
    const [t2, l2] = await scrolls();
    check(l2 < l1 && t2 === t1, `the log scrolls on its own (log ${l1} → ${l2}, tree ${t2})`);
    // Narrow the window: a change event puts the tree in the log's place, its scroll kept.
    await page.setViewportSize({ width: 390, height: 768 });
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => [
      document.querySelector('[data-testid="debug-chat-tree"]').dataset.mode,
      document.querySelector('[data-testid="debug-chat-tree-body"]').scrollTop,
    ]);
    check(
      after[0] === "inline" && after[1] >= t1 - 2, // (scroll anchoring may move it on as rows rewrap)
      `narrowed: inline, scroll kept (${after.join(", ")})`,
    );
    // Menu over the column: the column goes (one panel at a time).
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(350);
    await page.dblclick('[data-testid="debug-chat-pill-min"]');
    await page.waitForTimeout(350);
    const m = await page.evaluate(() => [
      !!document.querySelector('[data-testid="debug-menu"]'),
      document.querySelector("[data-debug-chat]").hasAttribute("data-two-col"),
    ]);
    check(m[0] && !m[1], "the menu hides the tree column");
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
    const ctx = await browser.newContext({
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
