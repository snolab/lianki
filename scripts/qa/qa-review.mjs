// /review QA: the in-site review page, end to end, silent, with iPhone-size
// screenshots in light and dark.
//
//   QA_BASE=http://localhost:3017 bun scripts/qa/qa-review.mjs [outDir]
//
// Signs up a throwaway dev account (needs DEV_EMAIL_PASSWORD_AUTH=1), adds
// three cards, then on /review: the card with its intervals, grading by tap
// and by key, the next card loading in place, delete with its confirmation,
// ?url= for a page that is no card yet, and "All reviews done for today".
// Also checks that the bare /api/fsrs/next page still answers as before.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/review-ui";
const EMAIL = `qa+review${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const iphone = devices["iPhone 13"];
const shots = [];

/**
 * The due card fills the window (owner, 2026-11-05): at the top of the page
 * the card's bottom sits within the last 10% of the window (above the bottom
 * island on a phone), and the open button and the four grades are fully in view.
 */
async function fillsWindow(page) {
  await page.evaluate(() => scrollTo(0, 0));
  await page
    .getByTestId("grade-3")
    .getByTestId("grade-interval")
    .filter({ hasText: /\d/ })
    .waitFor({ timeout: 10000 });
  const m = await page.evaluate(() => {
    const vh = innerHeight;
    const card = document.querySelector("[data-testid=review-card]")?.getBoundingClientRect();
    // The next-up strip is the last line of the stage, right under the card.
    const end = document.querySelector("[data-testid=review-next]")?.getBoundingClientRect();
    const ids = ["open-card", "grade-1", "grade-2", "grade-3", "grade-4"];
    const inView = ids.every((id) => {
      const r = document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect();
      return !!r && r.top >= 0 && r.bottom <= vh;
    });
    return { vh, bottom: end?.bottom ?? 0, top: card?.top ?? vh, inView };
  });
  console.log(`  window ${m.vh}px, card ${Math.round(m.top)}–${Math.round(m.bottom)}px`);
  return m.inView && m.bottom <= m.vh && m.bottom >= m.vh * 0.8 && m.top < m.vh * 0.25;
}

/**
 * Long intervals stay whole: each on one line, inside its button, nothing
 * sideways, at every width, and the grade buttons stay in the window.
 */
async function longIntervalsFit(storageState, colorScheme, width, height, lang) {
  const c = await newSilentContext(browser, {
    viewport: { width, height },
    colorScheme,
    baseURL: BASE,
    storageState,
  });
  const p = await c.newPage();
  const dues = ["10m", "1y 142d", "2y 333d", "10y 350d"];
  await p.route("**/api/fsrs/options*", (r) =>
    r.fulfill({
      json: { id: "x", options: dues.map((due, i) => ({ rating: i + 1, due })) },
    }),
  );
  await p.goto(`/review?lang=${lang}`, { waitUntil: "load" });
  await p
    .getByTestId("grade-4")
    .getByTestId("grade-interval")
    .filter({ hasText: /\d/ })
    .waitFor({ timeout: 10000 });
  const bad = await p.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth) out.push("page scrolls sideways");
    for (const n of [1, 2, 3, 4]) {
      const b = document.querySelector(`[data-testid=grade-${n}]`);
      const box = b.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(b);
      const inner = range.getBoundingClientRect();
      const interval = b.querySelector("[data-testid=grade-interval]");
      if (
        interval.getBoundingClientRect().height >
        parseFloat(getComputedStyle(interval).lineHeight) * 1.5
      )
        out.push(`${n}: interval wrapped`);
      if (inner.left < box.left - 0.5 || inner.right > box.right + 0.5)
        out.push(`${n}: wider than button`);
      if (inner.top < box.top - 0.5 || inner.bottom > box.bottom + 0.5)
        out.push(`${n}: taller than button`);
      if (box.top < 0 || box.bottom > innerHeight || box.right > innerWidth)
        out.push(`${n}: out of the window`);
    }
    return out;
  });
  check(
    bad.length === 0,
    `${colorScheme} ${width}x${height} ${lang}: long intervals whole ${bad.join("; ")}`,
  );
  const file = join(OUT, `review-long-${width}x${height}-${lang}-${colorScheme}.png`);
  await p.screenshot({ path: file });
  shots.push(file);
  await c.close();
}

async function context(colorScheme) {
  const ctx = await newSilentContext(browser, { ...iphone, colorScheme, baseURL: BASE });
  return ctx;
}

// ── Account + cards (API, as the app's own pages call it) ───────────────────
const setup = await context("light");
const api = setup.request;
const signup = await api.post("/api/auth/sign-up/email", {
  data: { email: EMAIL, password: PW, name: "QA Review" },
  headers: { origin: BASE },
});
check(signup.ok(), `sign-up (${signup.status()})`);
const state = await setup.storageState();

async function addCards(round = "") {
  for (const [url, title] of [
    [`https://en.wikipedia.org/wiki/Spaced_repetition${round}`, "Spaced repetition - Wikipedia"],
    [`https://en.wikipedia.org/wiki/Forgetting_curve${round}`, "Forgetting curve - Wikipedia"],
    [`https://example.com/third${round}`, "A third card"],
  ]) {
    const r = await api.post("/api/fsrs/add", { data: { url, title }, headers: { origin: BASE } });
    if (!r.ok()) throw new Error(`add ${url}: ${r.status()}`);
  }
}
await addCards();

// The bare flow still answers exactly as it did (byte-level check: unit/legacy-review-routes.test.ts).
{
  const r = await api.get("/api/fsrs/next");
  const body = await r.text();
  check(
    r.ok() &&
      /^<script>window\.open\(".*"\); location\.href='\/api\/fsrs\/repeat\/\?id=/.test(body),
    "GET /api/fsrs/next still serves the bare script page",
  );
}

for (const scheme of ["light", "dark"]) {
  const ctx = await newSilentContext(browser, {
    ...iphone,
    colorScheme: scheme,
    baseURL: BASE,
    storageState: state,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // React reports a bad child (a function or an object rendered as text) with
  // console.error, not as a page error: "Functions are not valid as a React child".
  page.on("console", (m) => {
    if (m.type() === "error" && /not valid as a React child/.test(m.text()))
      errors.push(m.text().slice(0, 300));
  });
  // Viewport-size shots (what the phone shows), scrolled to `target` when given:
  // a full-page capture would paint the fixed bottom bar mid-page.
  const shot = async (name, target) => {
    if (target)
      await page
        .locator(target)
        .first()
        .evaluate((el) => el.scrollIntoView({ block: "center" }));
    else await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(300);
    const file = join(OUT, `review-${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };

  await page.goto("/review", { waitUntil: "load" });
  await page.getByTestId("review-card").waitFor({ timeout: 20000 });
  await page
    .getByTestId("grade-3")
    .getByTestId("grade-interval")
    .filter({ hasText: /\d/ })
    .waitFor({ timeout: 10000 });
  check(await page.getByTestId("review-tutorial").isVisible(), `${scheme}: tutorial shown`);
  check(
    (await page.getByTestId("open-card").getAttribute("target")) === "_blank",
    `${scheme}: "Open this card" is a tap-opened link (target=_blank)`,
  );
  await shot("top");
  check(
    await fillsWindow(page),
    `${scheme}: iPhone — the due card fills the window, actions in view`,
  );
  const cardBox = () => page.getByTestId("review-card").boundingBox();
  const nextText = () => page.getByTestId("review-next-card").textContent();
  await page.getByTestId("review-next-card").waitFor({ timeout: 10000 });
  check(
    (await nextText()) !== (await page.locator("[data-testid=review-card] h2").textContent()),
    `${scheme}: next-up strip names another card`,
  );
  check(
    (await page.getByRole("radio", { name: "iPhone" }).getAttribute("aria-checked")) === "true",
    `${scheme}: a phone keeps its own tutorial tab`,
  );
  for (const [w, h, lang] of [
    [320, 568, "fr"],
    [360, 640, "en"],
    [390, 664, "zh"],
    [390, 664, "ar"],
    [1512, 794, "zh"],
    [1512, 794, "de"],
  ])
    await longIntervalsFit(state, scheme, w, h, lang);
  // Desktop: the same card fills a laptop window too.
  {
    const desk = await newSilentContext(browser, {
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
      baseURL: BASE,
      storageState: state,
    });
    const dp = await desk.newPage();
    await dp.goto("/review", { waitUntil: "load" });
    await dp.getByTestId("review-card").waitFor({ timeout: 20000 });
    check(
      (await dp.getByRole("radio", { name: "Web" }).getAttribute("aria-checked")) === "true" &&
        (await dp.getByText("switch back to this one").isVisible()),
      `${scheme}: a desktop browser opens on the Web tutorial tab`,
    );
    check(
      await fillsWindow(dp),
      `${scheme}: desktop — the due card fills the window, actions in view`,
    );
    const file = join(OUT, `review-desktop-${scheme}.png`);
    await dp.screenshot({ path: file });
    shots.push(file);
    await desk.close();
  }
  check(
    (await page.locator("[data-testid^=tutorial-step-]").count()) === 8,
    `${scheme}: tutorial has the 8 steps, side by side`,
  );

  // Step 6: open the card's tab, close it, come back → "How did this card feel?".
  {
    const popup = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.getByTestId("open-card").click();
    const tab = await popup;
    check(
      !(await page.getByTestId("return-prompt").isVisible()),
      `${scheme}: no grading prompt while the card's tab is open`,
    );
    await tab?.close();
    await page.bringToFront();
    // A headless page never really loses focus, so say what a real tab switch says.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    const asked = await page
      .getByTestId("return-prompt")
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    check(asked, `${scheme}: back from the card's tab → "How did this card feel?"`);
    if (asked) await shot("return-prompt", "[data-testid=return-prompt]");
  }
  // Auto-opened tabs (step 3, after a grade) are not needed here.
  ctx.on("page", (p) => void p.close().catch(() => {}));

  if (scheme === "light") {
    // Grade by tap: the next card loads in place, no navigation.
    await page.evaluate(() => scrollTo(0, 0));
    const boxBefore = await cardBox();
    const first = await page.locator("[data-testid=review-card] h2").textContent();
    const predicted = await nextText();
    await page.getByTestId("grade-3").click();
    await page
      .getByRole("status")
      .filter({ hasText: /Next review in/ })
      .waitFor();
    const moved = await page
      .waitForFunction(
        (t) => document.querySelector("[data-testid=review-card] h2")?.textContent !== t,
        first,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false);
    check(moved && page.url().endsWith("/review"), "grade → next card, same page");
    check(
      (await page.locator("[data-testid=review-card] h2").textContent()) === predicted,
      "the next-up strip named the card the grade moved on to",
    );
    await page
      .waitForFunction(
        (t) => {
          const el = document.querySelector("[data-testid=review-next-card]");
          return !!el && el.textContent !== t;
        },
        predicted,
        { timeout: 10000 },
      )
      .then(() => check(true, "the strip moves on to the new next card"))
      .catch(() => check(false, "the strip moves on to the new next card"));
    const boxAfter = await cardBox();
    check(
      !!boxBefore &&
        !!boxAfter &&
        Math.abs(boxBefore.y - boxAfter.y) < 1 &&
        Math.abs(boxBefore.height - boxAfter.height) < 1 &&
        (await page.evaluate(() => scrollY)) === 0,
      "the next card replaces this one in place (same box, no page jump)",
    );
    await shot("graded");

    // Delete asks first.
    await page.getByTestId("delete-card").click();
    check(await page.getByTestId("delete-yes").isVisible(), "delete asks for confirmation");
    await shot("delete-confirm", "[data-testid=delete-yes]");
    await page.getByTestId("delete-yes").click();
    await page.waitForTimeout(800);

    await page
      .getByTestId("review-next")
      .getByText("Nothing else is due")
      .waitFor({ timeout: 10000 })
      .then(() => check(true, "the strip says so when no other card is due"))
      .catch(() => check(false, "the strip says so when no other card is due"));

    // Grade by key.
    await page.keyboard.press("Digit4");
    await page.getByTestId("review-done").waitFor({ timeout: 10000 });
    check(true, "key 4 grades; then All reviews done");
    await shot("done", "[data-testid=review-done]");

    // Tutorial folds, and stays folded on this device.
    await page.getByTestId("tutorial-toggle").click();
    await page.reload({ waitUntil: "load" });
    await page.getByTestId("review-done").waitFor();
    check(
      !(await page.locator("[data-testid=review-tutorial] ol").isVisible()),
      "tutorial folded, remembered across a reload",
    );
    await page.getByTestId("tutorial-toggle").click();

    // ?url= for a page that is not a card yet: offered to add.
    // "load", not "networkidle": this page never went idle within 30 s here
    // (on main before the full-window card too); the text below is the wait.
    await page.goto(`/review?url=${encodeURIComponent("https://example.org/not-a-card")}`, {
      waitUntil: "load",
    });
    await page.getByText("This page is not a card yet").waitFor();
    await shot("not-card", "text=This page is not a card yet");
    await page.getByRole("button", { name: "Add it as a card" }).click();
    await page.getByTestId("review-card").waitFor();
    check(
      (await page.locator("[data-testid=review-card] h2").textContent())?.includes("example.org"),
      "?url= → add → that card, ready to grade",
    );
    await page.getByTestId("grade-4").click();
    await page.getByTestId("review-done").waitFor();
    check(!page.url().includes("url="), "?url= dropped once its card is graded");

    // Back to a card for the dark screenshots and the bookmarklet shot.
    await addCards("?again");
    await page.goto("/review", { waitUntil: "load" });
    await page.getByTestId("review-card").waitFor();
  } else {
    await page.goto("/review", { waitUntil: "load" });
    await page.getByTestId("review-card").waitFor();
  }

  await page.locator("[data-testid=review-bookmarklet] summary").click();
  const code = await page.locator("#lk-bookmarklet-code").inputValue();
  check(
    code.startsWith("javascript:(function(){") &&
      code.includes(`${new URL(BASE).origin}/review?url=`),
    `${scheme}: bookmarklet code shown for this origin`,
  );
  await shot("bookmarklet", "#lk-bookmarklet-code");

  // The Android steps by the toggle.
  if (scheme === "light") {
    await page.getByRole("radio", { name: "Android" }).click();
    check(await page.getByText("press Back").isVisible(), "Android toggle shows the Android steps");
    await shot("android");
  }

  // Every locale renders every string: no empty line, no function child.
  if (scheme === "light") {
    const LOCALES = "en zh hi es fr ar bn pt ru ur id de ja sw mr ko".split(" ");
    for (const lang of LOCALES) {
      const before = errors.length;
      await page.goto(`/review?lang=${lang}`, { waitUntil: "load" });
      await page.locator("[data-testid=review-bookmarklet] summary").click();
      const blank = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll(
              "[data-testid=review-bookmarklet] li, [data-testid=review-bookmarklet] p, footer a, [data-testid=review-tutorial] td",
            ),
          ].filter((el) => !el.textContent?.trim()).length,
      );
      check(blank === 0 && errors.length === before, `${lang}: every /review string renders`);
    }
    await page.goto("/review?lang=en", { waitUntil: "load" });
  }

  check(errors.length === 0, `${scheme}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

await setup.close();
await browser.close();
console.log(shots.map((s) => `  ${s}`).join("\n"));
console.log(failed ? `\n✗ ${failed} check(s) failed` : "\n✓ /review QA passed");
process.exit(failed ? 1 : 0);
