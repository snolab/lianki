#!/usr/bin/env bun
/**
 * The mic keeps its place on the screen (owner, 2026-11-07 19:27 JST:
 * "我们把麦克风跟另外几个按钮排到一起吧……这样折叠的时候，它位置就不会变").
 * The mic sits in the bar's cluster, [mark | + | mic | input] open and
 * [mark | Li | mic] folded (bar-geometry.ts), and full screen keeps the bar at
 * the panel's span (full-screen.ts fullBarSpan). This measures the mic's rect
 * (getBoundingClientRect) in every state and fails on a move over 0.5 px:
 *
 *   at rest (open, not typing) → open (typing) → full screen → back → folded
 *   (a tap on the mark) → open again (the pill's Li) → full screen from a
 *   panel dragged sideways
 *
 * and checks the cluster's touch areas (44 px), that the up-arrow and
 * scroll-down cover none of the mic, and the mic's order in the bar. Both
 * engines, light and dark, 414×848 and 320×568, on the local /harness with the
 * hot widget (as debug-chat-bar-qa.mjs). Browsers are muted (qa/silent.mjs);
 * getUserMedia is refused: nothing is recorded or played.
 *
 *   bun scripts/dev/debug-chat-mic-place-qa.mjs [--shots <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, webkit } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const MAX_MOVE = 0.5;

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
const sel = (id) => `[data-testid="${id}"]`;
const SECTION = "section[data-debug-chat]";
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (b) => (b ? `${r1(b.x)},${r1(b.y)} ${r1(b.width)}×${r1(b.height)}` : "none");
const moved = (a, b) =>
  !a || !b
    ? Infinity
    : Math.max(
        Math.abs(a.x - b.x),
        Math.abs(a.y - b.y),
        Math.abs(a.width - b.width),
        Math.abs(a.height - b.height),
      );
/** Per engine × width: the rest-state rect, for the report. */
const table = [];

async function run(engine, name, scheme, vp) {
  const browser = await launchSilent(engine);
  try {
    const ctx = await newSilentContext(browser, {
      viewport: vp,
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: name === "chromium",
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
    const tag = `${name} ${scheme} ${vp.width}:`;
    const settle = (ms = 450) => page.waitForTimeout(ms);
    const mic = () => page.locator(sel("debug-chat-mic")).boundingBox();
    const fold = () => page.getAttribute(SECTION, "data-fold");
    const isFull = () => page.locator(`${SECTION}[data-fullscreen]`).count();
    const shot = async (what) => {
      if (shots)
        await page.screenshot({ path: `${shots}/${name}-${scheme}-${vp.width}-${what}.png` });
    };
    const load = async (pos) => {
      await page.goto(`${ORIGIN}/harness?open&nofrontier&notree&full`);
      await page.evaluate((pos) => {
        localStorage.removeItem("lk:pref:chat-fold");
        localStorage.removeItem("lk:pref:chat-view");
        if (pos) localStorage.setItem("lk:debug-chat-pos", JSON.stringify(pos));
        else localStorage.removeItem("lk:debug-chat-pos");
      }, pos);
      await page.goto(`${ORIGIN}/harness?open&nofrontier&notree&full`);
      await page.waitForSelector(sel("debug-chat-mic"), { timeout: 60_000 });
      await settle(700);
    };
    const same = (base, now, what) => {
      const d = moved(base, now);
      check(
        d <= MAX_MOVE,
        `${tag} ${what}: the mic stays (${fmt(now)})`,
        `moved ${r1(d)} px from ${fmt(base)}`,
      );
    };

    await load(null);
    for (let i = 0; i < 24; i++)
      await page.evaluate(
        (i) =>
          globalThis.__push(
            `#${i} a line of the chat that takes some room`,
            i % 2 ? "owner" : "agent",
          ),
        i,
      );
    await settle();
    const rest = await mic();
    check(!!rest, `${tag} at rest: the mic is there (${fmt(rest)})`);
    table.push({ at: `${name} ${scheme} ${vp.width}`, rest: fmt(rest) });
    await shot("1-rest");

    // The bar's order and the touch areas.
    const bar = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const ids = [...q("debug-chat-pill").querySelectorAll("[data-testid]")]
        .map((e) => e.dataset.testid)
        .filter((t) =>
          [
            "debug-chat-pill-min",
            "debug-chat-attach",
            "debug-chat-mic",
            "debug-chat-input",
          ].includes(t),
        );
      const hit = (el) => {
        const b = el.getBoundingClientRect();
        const h = parseFloat(getComputedStyle(el, "::before").height);
        return { w: b.width, h: Math.max(b.height, h) };
      };
      return {
        ids,
        hits: ["debug-chat-pill-min", "debug-chat-attach", "debug-chat-mic"].map((t) => hit(q(t))),
      };
    });
    check(
      bar.ids.join() === "debug-chat-pill-min,debug-chat-attach,debug-chat-mic,debug-chat-input",
      `${tag} the bar: [mark | + | mic | input]`,
      bar.ids.join(" → "),
    );
    check(
      bar.hits.every((h) => h.w >= 44 && h.h >= 44),
      `${tag} the cluster's touch areas are ≥ 44 px`,
      JSON.stringify(bar.hits),
    );

    // Open: typing.
    await page.locator(sel("debug-chat-input")).focus();
    await settle();
    same(rest, await mic(), "typing");
    await shot("2-typing");

    // Scroll-down and the up-arrow: never over the mic.
    await page.evaluate((ask) => globalThis.__ask(ask), {
      askId: "a1",
      questions: [
        {
          id: "q1",
          question: "Merge it?",
          options: [
            { id: "y", label: "Yes", recommended: true },
            { id: "n", label: "No" },
          ],
        },
      ],
    });
    for (let i = 0; i < 16; i++)
      await page.evaluate(
        (i) => globalThis.__push(`#after-${i} more of the chat below the card`),
        i,
      );
    await settle();
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="debug-chat-column"]');
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      el.scrollTop = Math.max(0, el.scrollTop - 200);
      el.dispatchEvent(new Event("scroll"));
    });
    await settle();
    const overlap = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      const m = q("debug-chat-mic");
      const hit = (b) =>
        !!b && b.left < m.right && b.right > m.left && b.top < m.bottom && b.bottom > m.top;
      return {
        down: !!q("debug-chat-bottom"),
        jump: !!q("debug-chat-ask-jump"),
        over: hit(q("debug-chat-bottom")) || hit(q("debug-chat-ask-jump")),
      };
    });
    check(
      !overlap.over,
      `${tag} scroll-down and the up-arrow cover none of the mic`,
      JSON.stringify(overlap),
    );
    same(rest, await mic(), "scrolled up, buttons over the bar");
    await shot("3-buttons");
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="debug-chat-column"]');
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    await settle();

    // Full screen, and back.
    await page.locator(sel("debug-chat-fullscreen")).click();
    await settle();
    check((await isFull()) === 1, `${tag} full screen is on`);
    same(rest, await mic(), "full screen");
    const col = await page.locator(sel("debug-chat-column")).boundingBox();
    check(
      col.width >= vp.width - 2 * 12 - 1,
      `${tag} full screen: the log still takes the width`,
      fmt(col),
    );
    const side = await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth);
    check(side, `${tag} full screen: no horizontal scroll`);
    await shot("4-full");
    await page.locator(sel("debug-chat-fullscreen")).click();
    await settle();
    check((await isFull()) === 0, `${tag} back to the panel`);
    same(rest, await mic(), "back from full screen");

    // Folded by the mark, and open again by the pill's Li.
    await page.evaluate(() => document.activeElement?.blur?.());
    await settle(300);
    await page.locator(sel("debug-chat-pill-min")).click();
    await settle(900);
    check((await fold()) === "pill", `${tag} folded into the pill`);
    same(rest, await mic(), "folded");
    await shot("5-folded");
    await page.locator(sel("debug-chat-restore")).click();
    await settle(700);
    check((await fold()) === "open", `${tag} the Li opens it again`);
    same(rest, await mic(), "open again");

    // A panel dragged sideways: full screen keeps its span too.
    // (At 320 px the panel has only its 8 px inset to move into.)
    const dragX = vp.width > 400 ? -40 : -6;
    await load({ x: dragX, y: 0 });
    const left = await mic();
    check(
      !!left && Math.abs(left.x - (rest.x + dragX)) <= MAX_MOVE,
      `${tag} dragged ${-dragX} px left (${fmt(left)})`,
    );
    await page.locator(sel("debug-chat-fullscreen")).click();
    await settle();
    same(left, await mic(), "full screen from a dragged panel");
    await page.locator(sel("debug-chat-fullscreen")).click();
    await settle();
    await ctx.close();
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
        { width: 414, height: 848 },
        { width: 320, height: 568 },
      ])
        await run(engine, name, scheme, vp);
} finally {
  server.kill();
}

console.log("\nthe mic at rest (x,y w×h), the same in every state that passed:");
for (const t of table) console.log(`  ${t.at}: ${t.rest}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall mic-place checks passed");
