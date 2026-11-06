#!/usr/bin/env bun
/**
 * Browser checks for the up-arrow to unanswered asks (ask-above.ts) on the local
 * /harness page, hot widget, at iPhone size (390×844), light and dark, in Chromium
 * and WebKit:
 *
 *   - no button while no open ask is above the view; it appears once new lines
 *     push a card off, and shows a count with several
 *   - each tap goes to the nearest above, in view and clear of the fade
 *   - the button keeps its place, and covers neither the bar nor scroll-down
 *   - it disappears when none is above, and when the card is answered without
 *     being tapped here (the `answered` event from another device)
 *   - at rest a tap opens the log; a press outside the chat lets it go
 *   - an answered card never counts
 *   - a jump past cards within one frame still counts them right
 *
 * Browsers are muted (scripts/qa/silent.mjs); getUserMedia is refused.
 *
 *   bun scripts/dev/debug-chat-ask-jump-qa.mjs [--shots <dir>]
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

const JUMP = '[data-testid="debug-chat-ask-jump"]';
const DOWN = '[data-testid="debug-chat-bottom"]';
const COL = '[data-testid="debug-chat-column"]';
const BAR = '[data-testid="debug-chat-pill"]';

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

async function run(engine, name, scheme) {
  const browser = await launchSilent(engine);
  const ctx = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
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
  const tag = `${name} ${scheme}:`;
  const settle = () => page.waitForTimeout(350);
  const lines = (from, n) =>
    page.evaluate(
      ([from, n]) => {
        for (let i = from; i < from + n; i++)
          globalThis.__push(`#${i}# ${"a line of the chat that takes some room ".repeat(2)}`);
      },
      [from, n],
    );
  const pushAsk = (id) => page.evaluate((a) => globalThis.__ask(a), askOf(id));
  const count = async () => {
    const b = page.locator(JUMP);
    return (await b.count()) ? Number(await b.getAttribute("data-count")) : 0;
  };
  const cardInView = (id) =>
    page.evaluate(
      ([col, id]) => {
        const log = document.querySelector(col).getBoundingClientRect();
        const c = document.querySelector(`[data-ask="${id}"]`).getBoundingClientRect();
        const line = document.querySelector(`[data-msg="ask-${id}"]`).getBoundingClientRect();
        return {
          card: c.top >= log.top - 1 && c.bottom <= log.bottom + 1,
          clearOfFade: line.top - log.top,
        };
      },
      [COL, id],
    );
  const box = (sel) => page.locator(sel).boundingBox();
  const overlap = (a, b) =>
    !!a &&
    !!b &&
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;

  try {
    await page.goto(`${ORIGIN}/harness?open&nofrontier&notree`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 60_000 });
    await settle();

    await lines(0, 3);
    await pushAsk("a1");
    await settle();
    check((await count()) === 0, `${tag} an ask in view: no button`);
    await lines(10, 12);
    await settle();
    check(
      (await count()) === 1,
      `${tag} pushed off above: the button, count 1`,
      `${await count()}`,
    );
    const one = await page.locator(JUMP).innerText();
    check(!/\d/.test(one), `${tag} one: an arrow and no number`, one);
    check((await page.locator(`${JUMP} svg`).count()) === 1, `${tag} the arrow is an svg`);
    const label = await page.locator(JUMP).getAttribute("aria-label");
    check(
      !!label && label.includes("1") && !label.includes("{count}"),
      `${tag} aria-label filled`,
      label,
    );

    await pushAsk("a2");
    await lines(30, 12);
    await pushAsk("a3");
    await lines(50, 12);
    await settle();
    check((await count()) === 3, `${tag} three above: count 3`, `${await count()}`);
    check((await page.locator(JUMP).innerText()).includes("3"), `${tag} the count shows`);
    const b0 = await box(JUMP);
    const bar = await box(BAR);
    check(!overlap(b0, bar), `${tag} clear of the bar`, JSON.stringify({ b0, bar }));
    check(
      b0.x >= 0 && b0.x + b0.width <= 390,
      `${tag} on screen at phone width`,
      JSON.stringify(b0),
    );
    if (shots) await page.screenshot({ path: `${shots}/${name}-${scheme}-rest-3.png` });

    // Tap 1: the nearest, a3. The log opens to read it.
    await page.locator(JUMP).tap();
    await settle();
    let v = await cardInView("a3");
    check(v.card, `${tag} tap 1: the nearest (a3) is in view`, JSON.stringify(v));
    check(v.clearOfFade >= 30, `${tag} tap 1: clear of the fade`, JSON.stringify(v));
    const open1 = await box(COL);
    check(open1.height > 150, `${tag} tap 1: the log opened from its 3 lines`, `${open1.height}`);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${scheme}-after-tap.png` });

    check((await count()) === 2, `${tag} tap 1: two left`, `${await count()}`);
    const b1 = await box(JUMP);
    const down = await box(DOWN);
    check(!!down, `${tag} scroll-down shows after the jump`);
    check(!overlap(b1, down), `${tag} clear of scroll-down`, JSON.stringify({ b1, down }));
    check(!overlap(b1, await box(BAR)), `${tag} still clear of the bar`);
    check(
      Math.abs(b1.x + b1.width - (b0.x + b0.width)) <= 1,
      `${tag} its end edge stays put (a second tap lands on it)`,
      JSON.stringify({ b0, b1 }),
    );

    // Tap 2 and 3, on the same spot.
    await page.locator(JUMP).tap();
    await settle();
    v = await cardInView("a2");
    check(v.card, `${tag} tap 2: a2 in view`, JSON.stringify(v));
    check((await count()) === 1, `${tag} tap 2: one left`, `${await count()}`);
    await page.locator(JUMP).tap();
    await settle();
    v = await cardInView("a1");
    check(v.card, `${tag} tap 3: a1 in view`, JSON.stringify(v));
    check((await count()) === 0, `${tag} tap 3: none above, gone`, `${await count()}`);

    // Answer a1 in place; back at the end, a2 and a3 above again, a1 no more.
    await page.locator('[data-ask="a1"] [data-option="no"]').tap();
    await settle();
    await page.evaluate((c) => {
      const el = document.querySelector(c);
      el.scrollTop = el.scrollHeight;
    }, COL);
    await settle();
    check(
      (await count()) === 2,
      `${tag} back at the end: a2, a3 above, the answered a1 not`,
      `${await count()}`,
    );

    // In one frame from the end to the top and back: cards never in view on the way.
    const scrollTo = (top) =>
      page.evaluate(
        ([c, top]) => {
          const el = document.querySelector(c);
          el.scrollTop = top === "end" ? el.scrollHeight : top;
        },
        [COL, top],
      );
    await scrollTo(0);
    await settle();
    check(
      (await count()) === 0,
      `${tag} scrolled past them to the top: none above`,
      `${await count()}`,
    );
    await scrollTo("end");
    await settle();
    check(
      (await count()) === 2,
      `${tag} straight back to the end: two above again`,
      `${await count()}`,
    );

    // Answered on another device: the same stamp on the line, no tap here.
    await page.evaluate(() => globalThis.__answerAsk("a3"));
    await settle();
    check((await count()) === 1, `${tag} a3 answered elsewhere: count falls`, `${await count()}`);
    await page.evaluate(() => globalThis.__answerAsk("a2"));
    await settle();
    check((await count()) === 0, `${tag} a2 answered elsewhere: gone`, `${await count()}`);

    // A press outside the chat lets the held-open log go, back to the newest lines.
    const opened = await box(COL);
    await page.touchscreen.tap(20, 20);
    await settle();
    const closed = await box(COL);
    check(
      opened.height > closed.height,
      `${tag} a press outside folds the log again`,
      JSON.stringify({ opened: opened.height, closed: closed.height }),
    );
    const gap = await page.evaluate((c) => {
      const el = document.querySelector(c);
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    }, COL);
    check(gap <= 24, `${tag} and lands on the newest lines`, `${gap}`);
  } finally {
    await browser.close();
  }
}

try {
  for (const [engine, name] of [
    [chromium, "chromium"],
    [webkit, "webkit"],
  ])
    for (const scheme of ["light", "dark"]) await run(engine, name, scheme);
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);
