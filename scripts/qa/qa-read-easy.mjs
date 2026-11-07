// /read reader v2: what follows a paragraph's grade (owner, 2026-11-05 02:31 /
// 02:32 JST; lib/read/word-review.ts afterGrade). Silent; iPhone (both swipe
// variants) and desktop keys, a fake clock that runs.
//
//   QA_BASE=http://localhost:<port> bun scripts/qa/qa-read-easy.mjs [outDir]
//
// Against `wrangler dev` on the local D1 (qa:all -- --keep). A throwaway account and the public-domain fixture
// EPUB only:
//
// - dragged to Easy, the hint names how many words go Easy with it;
// - released: the toast says how many; its Undo inside the hold → nothing
//   reaches the server (no grade, no word card made or graded);
// - Easy again, past the hold: one /grade request carries the words; they
//   are graded (the item's plan is empty afterwards);
// - Hard: once the swipe settles, the item's word review opens; ✕ closes it;
// - a grade undone before the review opens: no review;
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

/**
 * The plans the page asked for, by the item's first word: the page's own
 * request body, replayed later to read the server's plan again.
 */
function watchPlans(page) {
  const asked = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/easy-plan")) asked.push(r.postData());
  });
  return {
    last: () => asked.at(-1),
    count: () => asked.length,
    /** The server's plan for a body the page sent. */
    plan: (id, body) =>
      page.evaluate(
        async ({ id, body }) =>
          (
            await (
              await fetch(`/api/read/${id}/easy-plan`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              })
            ).json()
          ).words,
        { id, body },
      ),
  };
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
  const { page, errs, id } = await setup(ctx, tag, swipe);
  const grades = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/grade") && r.method() === "POST") grades.push(r.postDataJSON());
  });
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(600);
  const cdp = await ctx.newCDPSession(page);
  let it = await anItem(page);
  check(!!it, `${tag}: an item with many words on screen`);
  if (!it) return ctx.close();
  const body1Item = it.id;
  const plans = watchPlans(page);

  // 1. Dragged to Easy (two levels right, the default sides): the hint.
  let hint = null;
  await drag(page, cdp, it, 110, async () => {
    await until(page, async () => (await page.getByTestId("read-easy-hint").count()) > 0, 3000);
    await until(
      page,
      async () => !!(await page.getByTestId("read-easy-hint").getAttribute("data-n")),
      3000,
    );
    hint = await page
      .getByTestId("read-easy-hint")
      .textContent()
      .catch(() => null);
    await page.screenshot({ path: join(OUT, `hint-${tag}.png`) });
  });
  const body1 = plans.last();
  const before = body1 ? await plans.plan(id, body1) : [];
  check(before.length > 0, `${tag}: the item has new words (${before.length})`);
  const n = Number(hint?.match(/\d+/)?.[0] ?? 0);
  check(n > 0, `${tag}: the hint names the words (${hint})`);
  check(
    n === before.length,
    `${tag}: the hint's count is the server's plan (${n} / ${before.length})`,
  );
  check(!(await page.getByTestId("read-easy-hint").count()), `${tag}: the hint goes on release`);
  const toast = page.getByTestId("read-made-toast");
  check(
    await until(page, async () => (await toast.count()) > 0, 4000),
    `${tag}: a toast after the Easy grade`,
  );
  const toastText = await toast.textContent().catch(() => "");
  check(toastText.includes(String(n)), `${tag}: the toast's count (${toastText})`);
  await page.screenshot({ path: join(OUT, `toast-${tag}.png`) });

  // 2. Undo in the toast, inside the hold: nothing is sent, ever.
  await toast.locator("button").click();
  await page.clock.fastForward("00:20");
  await page.waitForTimeout(800);
  check(
    grades.length === 0,
    `${tag}: the undone grade never reaches the server (${grades.length})`,
  );
  const still = await plans.plan(id, body1);
  check(still.length === before.length, `${tag}: no word card made or graded (${still.length})`);

  // 3. Easy again, the hold runs out: one request with the words.
  await page.waitForTimeout(400);
  it = (await anItem(page)) ?? it;
  const res = page.waitForResponse((r) => r.url().endsWith("/grade"), { timeout: 20000 });
  const asked = plans.count();
  await drag(page, cdp, it, 110);
  await until(page, async () => plans.count() > asked || it.id === body1Item, 3000);
  const body2 = plans.count() > asked ? plans.last() : body1;
  const plan2 = await plans.plan(id, body2);
  // The hold runs out on the page's clock as it runs (8 s).
  const resp = await res.catch(() => null);
  // The body can stay out of reach of the driver: a few seconds, then the plan tells.
  const body = resp
    ? await Promise.race([
        resp.json().catch(() => ({})),
        new Promise((ok) => setTimeout(() => ok({}), 3000)),
      ])
    : {};
  check(
    grades.length === 1 && grades[0].rating === 4 && grades[0].easyWords?.words?.length > 0,
    `${tag}: one request, Easy with the words (${grades.length}, ${grades[0]?.easyWords?.words?.length})`,
  );
  check(resp?.ok(), `${tag}: the grade request succeeded (${resp?.status()})`);
  if (body.words)
    check(
      body.words.graded === plan2.length,
      `${tag}: the server graded them (${JSON.stringify(body.words)} / ${plan2.length})`,
    );
  const after = await plans.plan(id, body2);
  check(after.length === 0, `${tag}: none of the item's words is due or new now (${after.length})`);

  // 4. Hard (one level left): the item's word review opens once it settles.
  await page.waitForTimeout(600);
  it = await anItem(page);
  if (it) {
    const asked3 = plans.count();
    await drag(page, cdp, it, -50);
    await until(page, async () => plans.count() > asked3, 2000);
    const left = await plans.plan(id, plans.last());
    const opened = await until(
      page,
      async () => (await page.getByTestId("read-word-review").count()) > 0,
      4000,
    );
    check(
      opened === left.length > 0,
      `${tag}: Hard opens the item's review when it has words (${opened}, ${left.length})`,
    );
    if (opened) {
      await page.screenshot({ path: join(OUT, `review-${tag}.png`) });
      await page.getByTestId("read-review-close").click();
      await page.waitForTimeout(400);
      check(!(await page.getByTestId("read-word-review").count()), `${tag}: ✕ closes it`);
    }
  }
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
  // at once by the fake voice), then the item's review opens over the book.
  await page.waitForTimeout(1000);
  const n0 = await spoken();
  await page.keyboard.press("KeyJ");
  check(
    await until(page, async () => (await page.getByTestId("read-word-review").count()) > 0, 5000),
    `${tag}: Good opens the item's review`,
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
  // Good (J): the review opens.
  await page.keyboard.press("KeyJ");
  check(
    await until(page, async () => (await page.getByTestId("read-word-review").count()) > 0, 4000),
    `${tag}: Good (J) opens the item's review`,
  );
  await page.keyboard.press("Escape");
  await page
    .getByTestId("read-review-close")
    .click()
    .catch(() => {});
  await page.waitForTimeout(400);
  // Easy (H): the toast; Undo (U) inside the hold sends nothing.
  await page.waitForTimeout(400);
  await page.keyboard.press("KeyH");
  const toast = page.getByTestId("read-made-toast");
  check(
    await until(page, async () => (await toast.count()) > 0, 4000),
    `${tag}: Easy (H) shows how many words went with it`,
  );
  await page.keyboard.press("KeyU");
  await page.waitForTimeout(300);
  check(!(await toast.count()), `${tag}: U undoes it and the toast goes`);
  await page.clock.fastForward("00:20");
  await page.waitForTimeout(1000);
  check(
    grades.every((g) => g.rating !== 4),
    `${tag}: the undone Easy never reaches the server (${grades.map((g) => g.rating)})`,
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
