// /read reader v2: review a paragraph's words in /words' own review, and 制卡
// (docs/books-plan.md, "Review a range's words"). Silent; iPhone light and
// dark, desktop.
//
//   QA_BASE=http://localhost:3417 node scripts/qa/qa-read-review.mjs [outDir]
//
// Against a local server on D1 (qa:all's wrangler dev). Throwaway accounts and
// the public-domain fixture EPUB only:
//
// - a click on a word: the card offers 「复习该段落所有单词」 and 制卡 (N);
// - 制卡 makes N cards (toast, Undo removes them; again makes them);
// - the review opens /words' rows for the paragraph's words over the book,
//   a swipe (touch) or a key (desktop) grades one through /words' review API;
// - ✕ closes it: the book is where it was.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-review";
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

async function setup(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+review-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Review" },
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
  await page.goto(`/read/${id}?reader=v2`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor();
  // The word map: marks on the words.
  await until(page, () => page.evaluate(() => !!document.querySelector(".lk-book [data-f]")));
  return { page, errs, id };
}

/** A word in a long paragraph, on screen. */
const aWord = (page) =>
  page.evaluate(() => {
    for (const p of document.querySelectorAll("[data-testid=reader-book] p[data-line]")) {
      if (p.querySelectorAll("[data-t]").length < 12) continue;
      const el = p.querySelector("[data-t]");
      const r = el.getBoundingClientRect();
      if (r.top < 120 || r.bottom > innerHeight * 0.45) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  });

const actions = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=read-select-card] [data-action]")].map((b) => [
      b.dataset.action,
      b.textContent,
    ]),
  );

async function run(device, scheme, touch) {
  const tag = `${touch ? "iphone" : "desktop"}-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: scheme });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag);
  // Scroll into the story so the review's return is visible.
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(600);
  const y0 = await page.evaluate(() => scrollY);
  const w = await aWord(page);
  check(!!w, "a word in a long paragraph is on screen");
  if (!w) return ctx.close();
  const click = () => (touch ? page.touchscreen.tap(w.x, w.y) : page.mouse.click(w.x, w.y));

  await click();
  await page.waitForTimeout(300);
  let acts = await actions(page);
  const make = acts.find(([a]) => a === "make-cards");
  check(
    acts.some(([a]) => a === "review-words"),
    `the card offers the review (${acts.map((a) => a[0])})`,
  );
  const n = Number(make?.[1]?.match(/\d+/)?.[0] ?? 0);
  check(n > 0, `制卡 shows the missing words' count (${make?.[1]})`);
  await page.screenshot({ path: join(OUT, `card-${tag}.png`) });

  // 制卡: the toast, then Undo.
  const madeReq = page.waitForResponse((r) => r.url().includes("/make-cards"));
  await page.locator("[data-action=make-cards]").click();
  const made = await (await madeReq).json();
  check(made.terms?.length === n, `制卡 made ${made.terms?.length} cards (card said ${n})`);
  await page.getByTestId("read-made-toast").waitFor();
  const undoReq = page.waitForResponse((r) => r.url().includes("/make-cards"));
  await page.getByTestId("read-made-toast").locator("button").click();
  const undone = await (await undoReq).json();
  check(undone.removed === n, `Undo removed them (${undone.removed})`);

  // The review: /words' rows over the book.
  await page.waitForTimeout(400);
  await click();
  await page.waitForTimeout(300);
  await page.locator("[data-action=review-words]").click();
  await page.getByTestId("read-word-review").waitFor();
  const rows = page.locator("[data-testid=read-word-review] [role=list] [data-i]");
  check(
    await until(page, async () => (await rows.count()) > 0),
    `the review lists the words (${await rows.count()})`,
  );
  const makeTop = page.getByTestId("read-review-make");
  check(await makeTop.isVisible(), "制卡 at the top of the review");
  await page.screenshot({ path: join(OUT, `review-${tag}.png`) });

  // Grade the first word: /words' own review endpoint.
  const graded = page.waitForResponse((r) => /\/api\/words\/lists\/[^/]+\/review/.test(r.url()), {
    timeout: 10000,
  });
  if (touch) {
    const b = await rows.first().boundingBox();
    const cdp = await ctx.newCDPSession(page);
    const y = b.y + b.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: b.x + 60, y }],
    });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: b.x + 60 + i * 12, y }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await rows.first().hover();
    await page.keyboard.press("3");
  }
  const res = await graded.catch(() => null);
  check(!!res && res.ok(), `a grade goes through /words' review (${res?.status()})`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `graded-${tag}.png`) });

  // Close: the book where it was.
  await page.getByTestId("read-review-close").click();
  await page.waitForTimeout(400);
  check(!(await page.getByTestId("read-word-review").count()), "✕ closes the review");
  const y1 = await page.evaluate(() => scrollY);
  check(Math.abs(y1 - y0) < 40, `the book kept its place (${y0} → ${y1})`);
  check(errs.length === 0, `no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

await run(devices["iPhone 13"], "light", true);
await run(devices["iPhone 13"], "dark", true);
await run(devices["Desktop Chrome"], "light", false);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
