// /read reader v2: what follows a passage's grade (owner, 2026-11-08, card
// ee79dfe4; lib/read/review-scope.ts). Each of the four levels opens the word
// review over a wider scope: Again this paragraph, Hard the chapter up to
// here, Good the whole chapter, Easy the whole book. Silent; iPhone (both
// swipe variants) and desktop keys, a fake clock that runs.
//
//   QA_BASE=http://localhost:<port> bun scripts/qa/qa-read-easy.mjs [outDir]
//
// Against `wrangler dev` on the local D1 (qa:all -- --keep). A throwaway account and the public-domain fixture
// EPUB only:
//
// - held on a level, the hint names its scope (data-scope);
// - released: once the swipe settles, that scope's review opens, pinned in
//   the URL (?review=p…/r… · u<line> · c<line> · b); ✕ closes it;
// - no grade carries an Easy word batch any more;
// - a grade undone before the review opens: no review;
// - a reload on ?review=b opens the book's review again;
// - reading aloud, a grade's review pauses it and closing resumes it from the
//   same sentence (the audio claim, #550): never stopped.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-easy";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};
const until = async (page, f, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

const browser = await launchSilent(chromium);

async function setup(ctx, tag, swipe) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+easy-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Easy" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/read", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL(/\/read\/[^/?]+$/, { timeout: 30000 });
  const id = page.url().split("/").pop();
  await page.goto(`/read/${id}?swipe=${swipe}`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor();
  await until(page, () => page.evaluate(() => !!document.querySelector(".lk-book [data-f]")));
  // A fake clock that still runs, from here on: fastForward ends the hold.
  await page.clock.install();
  const meta = await (await ctx.request.get(`/api/read/${id}`)).json();
  check(!!meta.readerV2, `${tag}: reader v2's server side is on`);
  return { page, errs, id };
}

/** The item at the eye line with many words, on screen. */
const anItem = (page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-testid=reader-book] [data-item]")) {
      const r = el.getBoundingClientRect();
      // On screen below the top strip, with room to touch, and words to grade.
      const top = Math.max(r.top, 120);
      const bottom = Math.min(r.bottom, innerHeight * 0.75);
      if (bottom - top < 30 || el.querySelectorAll("[data-t]").length < 8) continue;
      return {
        block: Number(el.dataset.block),
        id: el.dataset.item,
        x: r.left + r.width / 2,
        y: (top + bottom) / 2,
      };
    }
    return null;
  });

/** A finger drag `dx` px; `hold` runs before the finger lifts. */
async function drag(page, cdp, it, dx, hold) {
  const { x, y } = it;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / steps, y }],
    });
    await page.waitForTimeout(24);
  }
  await page.waitForTimeout(250);
  if (hold) await hold();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** The review's scope in the URL (?review=): p/r the item, u/c the chapter, b the book. */
const reviewParam = (page) => new URL(page.url()).searchParams.get("review");
const reviewOpen = (page, ms = 5000) =>
  until(page, async () => (await page.getByTestId("read-word-review").count()) > 0, ms);
async function closeReview(page, tag) {
  await page.getByTestId("read-review-close").click();
  await page.waitForTimeout(400);
  check(!(await page.getByTestId("read-word-review").count()), `${tag}: ✕ closes it`);
}

async function touchRun(swipe, scheme) {
  const tag = `iphone-${swipe}-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 13"],
    baseURL: BASE,
    colorScheme: scheme,
  });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag, swipe);
  const grades = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/grade") && r.method() === "POST") grades.push(r.postDataJSON());
  });
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(600);
  const cdp = await ctx.newCDPSession(page);

  // Each level (the default sides): its hint while held, then its review.
  const levels = [
    { dx: 110, scope: "book", ref: /^b$/, what: "Easy → the whole book" },
    { dx: 50, scope: "chapter", ref: /^c\d+$/, what: "Good → the whole chapter" },
    { dx: -50, scope: "upto", ref: /^u\d+$/, what: "Hard → the chapter up to here" },
    { dx: -110, scope: "para", ref: /^[pr]\d/, what: "Again → this paragraph" },
  ];
  for (const lv of levels) {
    await page.waitForTimeout(500);
    const it = await anItem(page);
    check(!!it, `${tag}: an item with many words on screen (${lv.scope})`);
    if (!it) break;
    let hint = null;
    await drag(page, cdp, it, lv.dx, async () => {
      await until(page, async () => (await page.getByTestId("read-scope-hint").count()) > 0, 3000);
      hint = await page
        .getByTestId("read-scope-hint")
        .getAttribute("data-scope")
        .catch(() => null);
      if (lv.scope === "book" || lv.scope === "upto")
        await page.screenshot({ path: join(OUT, `hint-${lv.scope}-${tag}.png`) });
    });
    check(hint === lv.scope, `${tag}: ${lv.what}: the hint names it (${hint})`);
    check(
      !(await page.getByTestId("read-scope-hint").count()),
      `${tag}: ${lv.scope}: the hint goes on release`,
    );
    // A fresh account knows none of the book's words: every scope has some.
    const opened = await reviewOpen(page);
    check(opened, `${tag}: ${lv.what}: the review opens`);
    if (!opened) continue;
    const ref = reviewParam(page);
    check(lv.ref.test(ref ?? ""), `${tag}: ${lv.scope}: pinned in the URL (?review=${ref})`);
    if (lv.scope === "book") await page.screenshot({ path: join(OUT, `review-book-${tag}.png`) });
    await closeReview(page, `${tag}: ${lv.scope}`);
  }
  // No Easy batch any more: past the hold, no grade carries words.
  await page.clock.fastForward("00:20");
  await page.waitForTimeout(1500);
  check(grades.length > 0, `${tag}: the passages' grades reach the server (${grades.length})`);
  check(
    grades.every((g) => !g.easyWords),
    `${tag}: no grade carries an Easy word batch (${grades.map((g) => g.rating)})`,
  );
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

/** Speech that never makes a sound: each line "ends" after window.__lineMs. */
const FAKE_SPEECH = `(() => {
  const spoken = (window.__spoken = []);
  let timers = [];
  const fake = {
    speaking: false,
    paused: false,
    getVoices: () => [{ lang: "en-US", name: "QA voice", voiceURI: "qa", default: true, localService: true }],
    speak(u) {
      spoken.push(u.text);
      timers.push(setTimeout(() => u.onstart && u.onstart(), 10));
      timers.push(setTimeout(() => u.onend && u.onend(), window.__lineMs || 200));
    },
    cancel() { timers.forEach(clearTimeout); timers = []; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: fake });
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ""; this.voice = null; this.rate = 1; this.onstart = this.onend = this.onerror = this.onboundary = null; }
    addEventListener() {}
    removeEventListener() {}
  };
})();`;

async function playRun() {
  const tag = "desktop-reading";
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...devices["Desktop Chrome"], baseURL: BASE });
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag, "js");
  await page.evaluate(() => (window.__lineMs = 1500));
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800);
  const status = () => page.getByTestId("read-play").getAttribute("data-status");
  const spoken = () => page.evaluate(() => window.__spoken.length);
  await page.getByTestId("read-play").click();
  check(
    await until(page, async () => (await spoken()) > 0, 5000),
    `${tag}: reading aloud (${await status()})`,
  );
  // Good (J) while reading: the next item starts (its sentences are queued
  // at once by the fake voice), then the chapter's review opens over the book.
  await page.waitForTimeout(1000);
  const n0 = await spoken();
  await page.keyboard.press("KeyJ");
  check(
    await until(page, async () => (await page.getByTestId("read-word-review").count()) > 0, 5000),
    `${tag}: Good opens the chapter's review`,
  );
  const playing = (await page.evaluate(() => window.__spoken)).slice(n0);
  check(
    (await status()) === "speaking",
    `${tag}: the reading is paused under the review, not stopped (${await status()})`,
  );
  const n = await spoken();
  await page.getByTestId("read-review-close").click();
  check(
    await until(page, async () => (await spoken()) > n + 1, 6000),
    `${tag}: closed, the reading goes on (${n} → ${await spoken()})`,
  );
  // On from the sentence it was on: a line of the item that was playing, not the book's start.
  const resumed = (await page.evaluate(() => window.__spoken))
    .slice(n)
    .filter((x) => x.trim() && playing.includes(x));
  check(
    resumed.length > 0 && (await status()) !== "idle",
    `${tag}: it resumes in the item it was reading (${JSON.stringify(resumed[0] ?? null).slice(0, 60)})`,
  );
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

async function deskRun() {
  const tag = "desktop";
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...devices["Desktop Chrome"], baseURL: BASE });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag, "js");
  const grades = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/grade") && r.method() === "POST") grades.push(r.postDataJSON());
  });
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800);
  // Good (J), undone at once: the review never opens.
  await page.keyboard.press("KeyJ");
  await page.keyboard.press("KeyU");
  await page.waitForTimeout(1200);
  check(!(await page.getByTestId("read-word-review").count()), `${tag}: undone at once: no review`);
  // Good (J): the chapter's review.
  await page.keyboard.press("KeyJ");
  check(await reviewOpen(page, 4000), `${tag}: Good (J) opens the chapter's review`);
  check(/^c\d+$/.test(reviewParam(page) ?? ""), `${tag}: ?review=${reviewParam(page)}`);
  await closeReview(page, `${tag}: chapter`);
  // Easy (H): the whole book's review, no toast, no word batch.
  await page.waitForTimeout(400);
  await page.keyboard.press("KeyH");
  check(await reviewOpen(page, 6000), `${tag}: Easy (H) opens the whole book's review`);
  check(reviewParam(page) === "b", `${tag}: ?review=${reviewParam(page)}`);
  const title = await page.getByTestId("read-word-review").getAttribute("aria-label");
  await page.screenshot({ path: join(OUT, `review-book-${tag}.png`) });
  // A refresh opens it again (the URL names the scope).
  await page.reload({ waitUntil: "load" });
  check(await reviewOpen(page, 15000), `${tag}: a reload opens the book's review again`);
  check(
    (await page.getByTestId("read-word-review").getAttribute("aria-label")) === title,
    `${tag}: the same review (${title})`,
  );
  await closeReview(page, `${tag}: book`);
  await page.clock.fastForward("00:20");
  await page.waitForTimeout(1000);
  check(
    grades.every((g) => !g.easyWords),
    `${tag}: no grade carries an Easy word batch (${grades.map((g) => g.rating)})`,
  );
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

await touchRun("js", "light");
await touchRun("native", "dark");
await deskRun();
await playRun();
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
