// The card-height pinch on /words (lib/words/row-pinch.ts, flag
// `words.pinch-card-height`, on by default) and the faded reviewed slip.
// Silent; iPhone 13 size on Chromium, two-finger touches over CDP.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-words-pinch.mjs [outDir]
//
// - a vertical pinch out makes every row taller while the fingers move, and
//   settles on a whole line; the page never zooms; nothing is graded;
// - a pinch in to the end leaves the word alone (the back cells take no room);
// - the height is kept (lk:words-card-height) and survives a reload;
// - one finger still swipes: a sideways drag grades the row, which fades
//   (.slip-done) at AA contrast; undo (Z) restores the normal look;
// - motion off: on lifting, the row is at its settled height at once;
// - the list holds still (owner, iPhone, 2026-11-10: it shook): through a
//   pinch and its settle, frame by frame, the row under the fingers stays
//   under them (within a few px) and every other row stays joined to it; no
//   native scroll runs under the pinch. Chromium (CDP touches) and WebKit
//   (iPhone 13; touches dispatched in the page, as WebKit's driver has no
//   multi-touch).
//
// The height follows the spread at the configured gain past a dead zone
// (config words.pinchGainPct / pinchDeadZonePct, lib/words/row-pinch.ts);
// this suite uses the defaults.
import { mkdirSync } from "node:fs";
import { chromium, devices, webkit } from "playwright";
import { CONFIG } from "../../lib/config.ts";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/words-pinch";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const GAIN = CONFIG["words.pinchGainPct"].default / 100;
const DEAD = CONFIG["words.pinchDeadZonePct"].default / 100;
/** The finger spread ratio that asks for a height ratio `k` (the inverse of pinchRatio). */
const spreadFor = (k) => (1 + DEAD) ** Math.sign(Math.log(k)) * k ** (1 / GAIN);

/** A fresh iPhone, signed up, holding one catalog list; the list's URL. */
async function phone(name, extra = {}, b = browser) {
  const ctx = await newSilentContext(b, { ...devices["iPhone 13"], ...extra });
  await ctx.addInitScript(() => {
    localStorage.setItem("lk:first-run", "account");
    localStorage.setItem(
      "lk:pref:nav-tip",
      JSON.stringify({ state: { dismissed: true }, version: 1 }),
    );
  });
  await ctx.route("**/api/words/tts?*", (r) =>
    r.fulfill({ contentType: "audio/wav", body: Buffer.from("RIFF0000WAVE") }),
  );
  const headers = { origin: BASE };
  const email = `qa+pinch-${name}-${Date.now()}@lianki.test`;
  const up = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: { email, password: PW, name: "QA Pinch" },
    headers,
  });
  if (!up.ok()) throw new Error(`sign-up ${up.status()}`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/words`, { waitUntil: "domcontentloaded" });
  const catalog = await page.evaluate(
    async () => (await (await fetch("/words/index.json")).json()).lists,
  );
  const first = catalog.find((c) => c.lang === "fr") ?? catalog[0];
  const made = await ctx.request.post(`${BASE}/api/words/lists`, {
    data: { name: first.name, lang: first.lang, source: first.id },
    headers,
  });
  if (!made.ok()) throw new Error(`add list ${made.status()}`);
  const { list } = await made.json();
  const url = `${BASE}/words?list=${list.id}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("[data-ready]").waitFor({ timeout: budget(60000) });
  await page.waitForTimeout(400);
  const cdp = b === browser ? await ctx.newCDPSession(page) : null;
  return { ctx, page, cdp, url };
}

const rowH = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('[role="listitem"][data-i]');
    return r ? r.getBoundingClientRect().height : 0;
  });

/** Two fingers at x, from (y1, y2) to (y1', y2'), in `steps` moves. */
async function pinch(cdp, page, { x, from, to, steps = 10, lift = true, during }) {
  const pts = (ys) => ys.map((y, i) => ({ x: x + i * 6, y, id: i + 1 }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from) });
  const seen = [];
  for (let s = 1; s <= steps; s++) {
    const ys = from.map((f, i) => f + ((to[i] - f) * s) / steps);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(ys) });
    await page.waitForTimeout(24);
    if (during) seen.push(await during());
  }
  if (lift) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return seen;
}

const graded = (page) => page.locator(".slip-done").count();
const zoom = (page) => page.evaluate(() => window.visualViewport?.scale ?? 1);
const stored = (page) => page.evaluate(() => localStorage.getItem("lk:words-card-height"));

// --- the pinch ---------------------------------------------------------------
{
  const { ctx, page, cdp, url } = await phone("a");
  const h0 = await rowH(page);
  check(h0 > 40, `rows at their default height: ${h0}px`);
  const box = await page.locator(".lk-words-list").boundingBox();
  const cy = box.y + box.height / 2;
  await page.screenshot({ path: `${OUT}/before.png` });

  const during = await pinch(cdp, page, {
    x: box.x + box.width * 0.6,
    from: [cy - 60, cy + 60],
    to: [cy - 140, cy + 140],
    during: () => rowH(page),
  });
  const grew = during.filter((h, i) => i > 0 && h > during[i - 1]).length;
  check(grew >= 3, `the rows follow the fingers while they move (${during.map(Math.round)})`);
  await page.waitForTimeout(400);
  const h1 = await rowH(page);
  check(h1 > h0 + 10, `pinched out: taller rows (${h0} → ${h1})`);
  check((await zoom(page)) === 1, "the page did not zoom");
  check((await graded(page)) === 0, "a pinch grades nothing");
  const f1 = await stored(page);
  check(Number(f1) > 1, `the height is kept: lk:words-card-height=${f1}`);
  const lines = await page.evaluate(() => {
    const c = document.querySelector('[role="listitem"][data-i] [data-back-cell="1"]');
    return c ? Math.round(parseFloat(c.style.maxHeight || "0") * 10) / 10 : 0;
  });
  check(lines > 2.5, `the example gets more lines (max-height ${lines}em)`);
  await page.screenshot({ path: `${OUT}/taller.png` });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-ready]").waitFor({ timeout: budget(60000) });
  await page.waitForTimeout(400);
  const h2 = await rowH(page);
  check(Math.abs(h2 - h1) <= 1, `kept across a reload (${h1} → ${h2})`);

  // Pinch in to the end: the word alone. The gain is low (the range is
  // small), so it takes a few pinches, as it would a finger.
  const cdp2 = await ctx.newCDPSession(page);
  for (let n = 0; n < 3; n++) {
    await pinch(cdp2, page, {
      x: box.x + box.width * 0.6,
      from: [cy - 200, cy + 200],
      to: [cy - 8, cy + 8],
      steps: 12,
    });
    await page.waitForTimeout(400);
  }
  const h3 = await rowH(page);
  check(h3 < h0 * 0.6, `pinched in: denser rows (${h0} → ${h3})`);
  const hidden = await page.evaluate(() => {
    const row = document.querySelector('[role="listitem"][data-i]');
    const cells = [...row.querySelectorAll("[data-back-cell]")];
    return cells.length > 0 && cells.every((c) => c.getBoundingClientRect().height === 0);
  });
  check(hidden, "at the bottom, the word alone (back cells take no room)");
  check((await zoom(page)) === 1, "the page did not zoom");
  await page.screenshot({ path: `${OUT}/word-only.png` });

  // Back to the default by a pinch out, then one finger swipes as before.
  const back = spreadFor(h0 / h3);
  await pinch(cdp2, page, {
    x: box.x + box.width * 0.6,
    from: [cy - 30, cy + 30],
    to: [cy - 30 * back, cy + 30 * back],
    steps: 14,
  });
  await page.waitForTimeout(400);
  const h4 = await rowH(page);
  check(Math.abs(h4 - h0) <= 1, `pinched back home: the default height (${h4})`);
  check((await stored(page)) === "1", `home is factor 1 (${await stored(page)})`);

  const row = page.locator('[role="listitem"][data-i]').nth(1);
  const rb = await row.boundingBox();
  const y = rb.y + rb.height / 2;
  await cdp2.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: rb.x + rb.width * 0.3, y, id: 1 }],
  });
  for (let s = 1; s <= 10; s++) {
    await cdp2.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: rb.x + rb.width * 0.3 + s * 14, y, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(800);
  check((await graded(page)) >= 1, "one finger still swipes: the row is graded");
  // The faded look: one muted ink at AA contrast on the veiled slip.
  const look = await page.evaluate(() => {
    const done = document.querySelector(".slip-done");
    const fresh = [...document.querySelectorAll('.slip[role="listitem"]')].find(
      (r) => !r.classList.contains("slip-done") && !r.querySelector(".lk-back"),
    );
    const ink = (el) => getComputedStyle(el.querySelector(".slip-term") ?? el).color;
    return { done: done && ink(done), fresh: fresh && ink(fresh) };
  });
  check(look.done && look.done !== look.fresh, `a reviewed slip fades (${look.done})`);
  await page.screenshot({ path: `${OUT}/faded.png` });
  await page.keyboard.press("z");
  await page.waitForTimeout(600);
  check((await graded(page)) === 0, "undo restores the normal look");
  void url;
  await ctx.close();
}

// --- motion off --------------------------------------------------------------
{
  const { ctx, page, cdp } = await phone("b", { reducedMotion: "reduce" });
  const box = await page.locator(".lk-words-list").boundingBox();
  const cy = box.y + box.height / 2;
  await pinch(cdp, page, {
    x: box.x + box.width * 0.6,
    from: [cy - 60, cy + 60],
    to: [cy - 117, cy + 117],
    lift: false,
  });
  await page.waitForTimeout(100);
  // Record each frame's height after lifting: no settle in between.
  await page.evaluate(() => {
    window.__hs = [];
    const tick = () => {
      const r = document.querySelector('[role="listitem"][data-i]');
      window.__hs.push(Math.round(r.getBoundingClientRect().height));
      if (window.__hs.length < 20) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(600);
  const hs = await page.evaluate(() => window.__hs);
  const after = hs.slice(2);
  check(new Set(after).size === 1, `motion off: the new height at once (${hs.join(",")})`);
  await ctx.close();
}

// --- the list holds still ----------------------------------------------------
/**
 * Records every frame from now until `stopWatch`: where the anchor row's
 * point (under `midY` at the start) is against `midY`, and the widest gap or
 * overlap between two neighbouring rows.
 */
const watch = (page, midY) =>
  page.evaluate((midY) => {
    const list = document.querySelector(".lk-words-list");
    const rows = () => [...list.querySelectorAll('[role="listitem"][data-i]')];
    const row = rows().find((r) => {
      const b = r.getBoundingClientRect();
      return b.top <= midY && b.bottom > midY;
    });
    const b = row.getBoundingClientRect();
    const L = {
      i: row.dataset.i,
      frac: (midY - b.top) / b.height,
      drift: [],
      gaps: [],
      hs: [],
      stop: false,
    };
    window.__hold = L;
    const tick = () => {
      if (L.stop) return;
      const r = list.querySelector(`[data-i="${L.i}"]`);
      if (r) {
        const rb = r.getBoundingClientRect();
        L.drift.push(rb.top + L.frac * rb.height - midY);
        L.hs.push(rb.height);
      }
      const seen = rows()
        .map((e) => [Number(e.dataset.i), e.getBoundingClientRect()])
        .sort((x, y) => x[0] - y[0]);
      let worst = 0;
      for (let k = 1; k < seen.length; k++)
        if (seen[k][0] === seen[k - 1][0] + 1)
          worst = Math.max(worst, Math.abs(seen[k][1].top - seen[k - 1][1].bottom));
      L.gaps.push(worst);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, midY);
const stopWatch = (page) =>
  page.evaluate(() => {
    const L = window.__hold;
    L.stop = true;
    return L;
  });

/** Two touches dispatched in the page (WebKit's driver has no multi-touch). */
async function pagePinch(page, { x, from, to, steps }) {
  await page.evaluate(
    async ({ x, from, to, steps }) => {
      const list = document.querySelector(".lk-words-list");
      const fire = (type, ys) => {
        const target = document.elementFromPoint(x, (ys[0] + ys[1]) / 2) ?? list;
        const pts = ys.map((y, i) => ({
          identifier: i + 1,
          target,
          clientX: x + i * 6,
          clientY: y,
          pageX: x + i * 6,
          pageY: y,
        }));
        let touches = pts;
        try {
          touches = pts.map((p) => new Touch(p));
        } catch {}
        const live = type === "touchend" ? [] : touches;
        let e;
        try {
          e = new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: live,
            targetTouches: live,
            changedTouches: touches,
          });
        } catch {
          e = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(e, "touches", { value: live });
        }
        target.dispatchEvent(e);
      };
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      fire("touchstart", from);
      for (let s = 1; s <= steps; s++) {
        fire(
          "touchmove",
          from.map((f, i) => f + ((to[i] - f) * s) / steps),
        );
        await frame();
        await frame();
      }
      fire("touchend", to);
    },
    { x, from, to, steps },
  );
}

for (const [engine, type] of [
  ["chromium", null],
  ["webkit", webkit],
]) {
  const b = type ? await launchSilent(type) : browser;
  try {
    const { ctx, page, cdp } = await phone(`hold-${engine}`, {}, b);
    // Into the list, so there are rows above and below the fingers.
    await page.evaluate(() => {
      const list = document.querySelector(".lk-words-list");
      const r = list.querySelector('[role="listitem"][data-i]').getBoundingClientRect();
      list.scrollTop += r.height * 8;
    });
    await page.waitForTimeout(400);
    const box = await page.locator(".lk-words-list").boundingBox();
    const cy = Math.round(box.y + box.height * 0.45);
    const x = box.x + box.width * 0.6;
    for (const [what, from, to] of [
      ["out", [cy - 50, cy + 50], [cy - 160, cy + 160]],
      ["in", [cy - 160, cy + 160], [cy - 30, cy + 30]],
    ]) {
      const scrollNow = () =>
        page.evaluate(() => document.querySelector(".lk-words-list").scrollTop);
      const h0 = await rowH(page);
      const top0 = await scrollNow();
      await watch(page, cy);
      if (cdp) await pinch(cdp, page, { x, from, to, steps: 16 });
      else await pagePinch(page, { x, from, to, steps: 16 });
      await page.waitForTimeout(600);
      const L = await stopWatch(page);
      const h1 = await rowH(page);
      const top1 = await scrollNow();
      const drift = Math.max(...L.drift.map(Math.abs));
      const gap = Math.max(...L.gaps);
      const sizes = new Set(L.hs.map((h) => Math.round(h))).size;
      check(
        what === "out" ? h1 > h0 + 5 : h1 < h0 - 5,
        `${engine} pinch ${what}: the rows changed (${h0} → ${h1}, ${sizes} heights over ${L.hs.length} frames)`,
      );
      check(
        top1 !== top0,
        `${engine} pinch ${what}: the list scrolled to hold the row (${top0} → ${top1})`,
      );
      check(
        drift <= 3,
        `${engine} pinch ${what}: row ${L.i} stays under the fingers, every frame (worst ${drift.toFixed(1)}px)`,
      );
      check(
        gap <= 1.5,
        `${engine} pinch ${what}: no row jumps off its neighbours (worst ${gap.toFixed(1)}px)`,
      );
      const frozen = await page.evaluate(() =>
        document.querySelector(".lk-words-list").classList.contains("lk-pinching"),
      );
      check(!frozen, `${engine} pinch ${what}: the list scrolls again after the pinch`);
    }
    check((await graded(page)) === 0, `${engine}: the pinches graded nothing`);
    await page.screenshot({ path: `${OUT}/hold-${engine}.png` });
    await ctx.close();
  } finally {
    if (type) await b.close();
  }
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
