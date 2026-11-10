// The /words first-visit walkthrough (lib/words/onboarding.ts,
// app/(app)/words/WordsOnboarding.tsx). Silent; iPhone size, light and dark,
// screenshots of each pass.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-words-onboarding.mjs [outDir]
//
// `words.onboarding` is on by default (no row needed). For each colour scheme,
// a new account:
// - first visit to /words: the walkthrough opens by itself, with a caption;
// - Skip closes it, the "?" by the heading stays (44 px hit area, labelled),
//   and the seen state is kept (lk:words-onboarded = "1", a synced pref);
// - a reload: it does not open again;
// - the "?" replays it from the first scene; ✕ closes it.
// - "rate" is a swipe, not buttons: two slips slide right and left over the
//   four grades (Good / Easy uncovered on the left, Hard / Again on the right);
// - "returns" plays a 3-2-1 countdown right of the card, the card settles in
//   place (dashed, "↓ back"), and its copy turns up lower as the list scrolls.
// Then reduced motion: still frames, Next / Back step the captions, the last
// scene's button closes it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/words-onboarding";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);

async function pass(scheme, reducedMotion = "no-preference") {
  const tag = `${scheme}${reducedMotion === "reduce" ? "-still" : ""}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 13"],
    colorScheme: scheme,
    reducedMotion,
    lkOnboarding: true,
  });
  await ctx.addInitScript(() => localStorage.setItem("lk:first-run", "account"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => {
    if (!e.message.includes("Turnstile")) errs.push(e.message);
  });
  const up = await page.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: {
      email: `qa+onboard-${tag}-${Date.now()}@lianki.test`,
      password: PW,
      name: "QA Onboard",
    },
    headers: { origin: BASE },
  });
  check(up.ok(), `${tag}: sign-up (${up.status()})`);

  const dialog = page.locator("[data-words-onboarding]");
  const help = page.locator("[data-words-onboarding-help]");
  const caption = page.locator("[data-words-onboarding-caption]");

  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  // A device that never synced waits a moment for the account's answer.
  await dialog.waitFor({ timeout: 10000 }).catch(() => {});
  check(await dialog.isVisible(), `${tag}: opens by itself on the first visit`);
  check(((await caption.textContent()) ?? "").trim().length > 0, `${tag}: with a caption`);
  check(
    (await dialog.getAttribute("aria-label")) === "How the word list works",
    `${tag}: labelled`,
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, `${tag}-first.png`) });

  const opacity = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(`[data-words-onboarding] ${s}`);
      return el ? Number(getComputedStyle(el).opacity) : -1;
    }, sel);
  const toScene = async (id) => {
    for (let i = 0; i < 5 && (await dialog.getAttribute("data-scene")) !== id; i++)
      await page.locator("[data-words-onboarding-next]").click();
    return (await dialog.getAttribute("data-scene")) === id;
  };

  if (reducedMotion === "reduce") {
    check((await dialog.getAttribute("data-static")) === "", `${tag}: still frames`);
    const seen = [await caption.textContent()];
    for (let i = 0; i < 4; i++) {
      await page.locator("[data-words-onboarding-next]").click();
      seen.push(await caption.textContent());
      const id = await dialog.getAttribute("data-scene");
      if (id === "rate") {
        const labels = await page
          .locator("[data-words-onboarding] .ob-rv + text")
          .allTextContents();
        check(
          labels.join("|") === "Good|Easy|Hard|Again",
          `${tag}: rate is a swipe over the four grades (${labels.join("|")})`,
        );
        check(
          (await page.locator("[data-words-onboarding] .ob-btn").count()) === 0,
          `${tag}: rate draws no grade buttons`,
        );
      }
      if (id === "returns") {
        check((await opacity(".ob-frozen")) === 1, `${tag}: returns: the card settles in place`);
        check((await opacity(".ob-return")) === 1, `${tag}: returns: its copy is lower down`);
        check((await opacity(".ob-ring")) === 0, `${tag}: returns: still frame, no countdown`);
        await page.screenshot({ path: join(OUT, `${tag}-returns.png`) });
      }
    }
    check(new Set(seen).size === 5, `${tag}: Next steps through five captions`);
    await page.screenshot({ path: join(OUT, `${tag}-last.png`) });
    await page.locator("[data-words-onboarding-back]").click();
    check((await caption.textContent()) === seen[3], `${tag}: Back steps back`);
    await page.locator("[data-words-onboarding-next]").click();
    await page.locator("[data-words-onboarding-next]").click(); // "Got it"
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    check(!(await dialog.isVisible()), `${tag}: the last scene's button closes it`);
  } else {
    // With motion the scenes play on by themselves.
    const first = await caption.textContent();
    const moved = await page
      .waitForFunction(
        (t) => document.querySelector("[data-words-onboarding-caption]")?.textContent !== t,
        first,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    check(moved, `${tag}: plays on by itself`);
    // "rate": mid-swipe, the right-hand slip has slid off its grades.
    check(await toScene("rate"), `${tag}: reaches rate`);
    await page.waitForTimeout(1300);
    const slid = await page.evaluate(() => {
      const el = document.querySelector("[data-words-onboarding] .ob-slide-r");
      return el ? new DOMMatrix(getComputedStyle(el).transform).e : 0;
    });
    check(slid > 10, `${tag}: rate: the slip slides right (${slid.toFixed(0)})`);
    await page.screenshot({ path: join(OUT, `${tag}-rate.png`) });
    // "returns": the countdown runs, then the card settles and comes back lower.
    check(await toScene("returns"), `${tag}: reaches returns`);
    await page.waitForTimeout(900);
    check((await opacity(".ob-ring")) > 0.5, `${tag}: returns: a countdown right of the card`);
    check(
      (await opacity(".ob-n3")) + (await opacity(".ob-n2")) > 0.5,
      `${tag}: returns: counting 3, 2…`,
    );
    check((await opacity(".ob-return")) < 0.5, `${tag}: returns: the copy is not there yet`);
    await page.screenshot({ path: join(OUT, `${tag}-countdown.png`) });
    await page.waitForTimeout(5600);
    check((await opacity(".ob-ring")) === 0, `${tag}: returns: the countdown is over`);
    check((await opacity(".ob-frozen")) > 0.9, `${tag}: returns: the card settled in place`);
    check((await opacity(".ob-return")) > 0.9, `${tag}: returns: its copy turned up lower`);
    await page.screenshot({ path: join(OUT, `${tag}-returned.png`) });
    await page.locator("[data-words-onboarding-skip]").click();
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    check(!(await dialog.isVisible()), `${tag}: Skip closes it`);
  }

  check(await help.isVisible(), `${tag}: the "?" is by the heading`);
  const box = await help.boundingBox();
  check(
    !!box && box.width >= 44 && box.height >= 44,
    `${tag}: "?" hit area ${box?.width}×${box?.height}`,
  );
  check(
    (await help.getAttribute("aria-label")) === "How the word list works",
    `${tag}: "?" labelled`,
  );
  check(
    (await page.evaluate(() => localStorage.getItem("lk:words-onboarded"))) === "1",
    `${tag}: seen is kept (lk:words-onboarded)`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-closed.png`) });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  check(!(await dialog.isVisible()), `${tag}: not shown again after a reload`);

  await help.click();
  await dialog.waitFor({ timeout: 5000 });
  check(await dialog.isVisible(), `${tag}: the "?" replays it`);
  check((await dialog.getAttribute("data-scene")) === "tap", `${tag}: from the first scene`);
  await page.locator("[data-words-onboarding-close]").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  check(!(await dialog.isVisible()), `${tag}: ✕ closes it`);

  check(errs.length === 0, `${tag}: no page errors${errs.length ? `: ${errs.join(" | ")}` : ""}`);
  await ctx.close();
}

try {
  await pass("light");
  await pass("dark");
  await pass("light", "reduce");
} catch (e) {
  console.log(`✗ ${e.message}`);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
