// /review QA: the in-site review page, end to end, silent, with iPhone-size
// screenshots in light and dark.
//
//   QA_BASE=http://localhost:3017 node scripts/qa/qa-review.mjs [outDir]
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

  await page.goto("/review", { waitUntil: "networkidle" });
  await page.getByTestId("review-card").waitFor({ timeout: 20000 });
  await page.getByTestId("grade-3").locator("text=/\\d/").waitFor({ timeout: 10000 });
  check(await page.getByTestId("review-tutorial").isVisible(), `${scheme}: tutorial shown`);
  check(
    (await page.getByTestId("open-card").getAttribute("target")) === "_blank",
    `${scheme}: "Open this card" is a tap-opened link (target=_blank)`,
  );
  await shot("top");
  await shot("card", "[data-testid=review-card]");

  if (scheme === "light") {
    // Grade by tap: the next card loads in place, no navigation.
    const first = await page.locator("[data-testid=review-card] h2").textContent();
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
    await shot("graded", "[data-testid=review-card]");

    // Delete asks first.
    await page.getByTestId("delete-card").click();
    check(await page.getByTestId("delete-yes").isVisible(), "delete asks for confirmation");
    await shot("delete-confirm", "[data-testid=delete-yes]");
    await page.getByTestId("delete-yes").click();
    await page.waitForTimeout(800);

    // Grade by key.
    await page.keyboard.press("Digit4");
    await page.getByTestId("review-done").waitFor({ timeout: 10000 });
    check(true, "key 4 grades; then All reviews done");
    await shot("done", "[data-testid=review-done]");

    // Tutorial folds, and stays folded on this device.
    await page.getByTestId("tutorial-toggle").click();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("review-done").waitFor();
    check(
      !(await page.locator("[data-testid=review-tutorial] ol").isVisible()),
      "tutorial folded, remembered across a reload",
    );
    await page.getByTestId("tutorial-toggle").click();

    // ?url= for a page that is not a card yet: offered to add.
    await page.goto(`/review?url=${encodeURIComponent("https://example.org/not-a-card")}`, {
      waitUntil: "networkidle",
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
    await page.goto("/review", { waitUntil: "networkidle" });
    await page.getByTestId("review-card").waitFor();
  } else {
    await page.goto("/review", { waitUntil: "networkidle" });
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

  check(errors.length === 0, `${scheme}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

await setup.close();
await browser.close();
console.log(shots.map((s) => `  ${s}`).join("\n"));
console.log(failed ? `\n✗ ${failed} check(s) failed` : "\n✓ /review QA passed");
process.exit(failed ? 1 : 0);
