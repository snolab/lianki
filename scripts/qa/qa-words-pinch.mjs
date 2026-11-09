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
// - motion off: on lifting, the row is at its settled height at once.
import { mkdirSync } from "node:fs";
import { chromium, devices } from "playwright";
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

/** A fresh iPhone, signed up, holding one catalog list; the list's URL. */
async function phone(name, extra = {}) {
  const ctx = await newSilentContext(browser, { ...devices["iPhone 13"], ...extra });
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
  const cdp = await ctx.newCDPSession(page);
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

  // Pinch in to the end: the word alone.
  const cdp2 = await ctx.newCDPSession(page);
  await pinch(cdp2, page, {
    x: box.x + box.width * 0.6,
    from: [cy - 150, cy + 150],
    to: [cy - 8, cy + 8],
    steps: 12,
  });
  await page.waitForTimeout(400);
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
  await pinch(cdp2, page, {
    x: box.x + box.width * 0.6,
    from: [cy - 30, cy + 30],
    to: [cy - 30 * (h0 / h3), cy + 30 * (h0 / h3)],
    steps: 10,
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

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
