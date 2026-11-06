// /read reader v2: grading from the selection card's handle (docs/books-plan.md,
// "Grading from the selection card"). Silent; desktop and iPhone.
//
//   QA_BASE=http://localhost:3471 bun scripts/qa/qa-read-card-grade.mjs [outDir]
//
// Against a local server on D1 (qa:all's wrangler dev, read.reader-v2 on in
// the local D1). Throwaway accounts and the public-domain fixture EPUB only:
//
// - tapping or clicking the text never grades (no batch-grade write);
// - a word with no card is a preview, with no 制卡 button: a tap, a drag short of
//   a level or closing the card stores nothing (the tap may ask for its meaning:
//   no model is set up here; qa-read-tap-gloss.mjs has that with a stubbed one);
// - a tap on the knob never grades; a drag past a level adds it and grades it
//   (one batch, sent after the hold); keys 1–4 and the hidden buttons do too;
// - the toast's Undo and U drop a held batch; dragging the knob up takes a sent
//   one back (the server's undo), and the word is a preview again;
// - a sentence gets the handle and its drag grades that sentence.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-card-grade";
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
    data: { email: `qa+cardgrade-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Grade" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  // Every write the handle makes: grades and undos (the probe is a read).
  const writes = [];
  // Whatever else could store or spend on a new word.
  const others = [];
  page.on("request", (q) => {
    if (q.method() === "POST" && q.url().includes("/make-cards")) others.push("make-cards");
    if (!q.url().includes("/batch-grade") || q.method() !== "POST") return;
    const b = JSON.parse(q.postData() || "{}");
    if (!b.probe) writes.push(b);
  });
  await page.goto("/read", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL(/\/read\/[^/?]+$/, { timeout: 30000 });
  const id = page.url().split("/").pop();
  await page.goto(`/read/${id}?reader=v2`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor();
  await until(page, () => page.evaluate(() => !!document.querySelector(".lk-book [data-f]")));
  return { page, errs, writes, others };
}

/** A not-recognised or new word (no card yet) in a long paragraph, on screen. */
const aNewWord = (page) =>
  page.evaluate(() => {
    for (const p of document.querySelectorAll("[data-testid=reader-book] p[data-line]")) {
      if (p.querySelectorAll("[data-t]").length < 6) continue;
      for (const el of p.querySelectorAll('[data-t][data-f="n"], [data-t][data-f="u"]')) {
        const r = el.getBoundingClientRect();
        if (r.top < 120 || r.bottom > innerHeight * 0.6 || r.width < 18) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
      }
    }
    return null;
  });

const knobBox = async (page) => page.getByTestId("read-grade-knob").boundingBox();

async function mouseDrag(page, dx, dy) {
  const b = await knobBox(page);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(x + (dx * i) / 14, y + (dy * i) / 14);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
}

async function touchDrag(cdp, page, dx, dy) {
  const b = await knobBox(page);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 14; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 14, y: y + (dy * i) / 14 }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function run(device, scheme, touch) {
  const tag = `${touch ? "iphone" : "desktop"}-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: scheme });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs, writes, others } = await setup(ctx, tag);
  const cdp = touch ? await ctx.newCDPSession(page) : null;
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(600);
  const w = await aNewWord(page);
  check(!!w, `a word without a card is on screen (${w?.text})`);
  if (!w) return ctx.close();
  const tapWord = () => (touch ? page.touchscreen.tap(w.x, w.y) : page.mouse.click(w.x, w.y));
  /** The word's card, freshly opened (a tap on an open word would widen or close it). */
  const reopen = async () => {
    const close = page.getByTestId("read-select-close");
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.waitForTimeout(800);
    await tapWord();
  };

  // A tap on the word: a preview with the slider, no button, nothing stored.
  await tapWord();
  const knob = page.getByTestId("read-grade-knob");
  // The strip's idle hint says it is not added (the fixture's account reads English).
  const preview = page.getByTestId("read-grade-hint").filter({ hasText: /not added yet/i });
  check(await until(page, () => knob.isVisible(), 15000), "a word without a card: the slider");
  check(await until(page, () => preview.isVisible()), "the hint: not added yet");
  check(
    (await page.getByTestId("read-select-meaning").isVisible()) ||
      (await page.getByTestId("read-new-word-context").isVisible()),
    "the preview shows a meaning there already is, else the word's sentence",
  );
  const noButton = async () =>
    (await page.locator("[data-action=make-cards],[data-action=make-phrase]").count()) === 0;
  check(await noButton(), "no 制卡 button on a word's card");
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `preview-${tag}.png`) });
  // Closing it stores nothing; the word is the same preview when it comes back.
  await page.getByTestId("read-select-close").click();
  await page.waitForTimeout(300);
  await tapWord();
  check(await until(page, () => knob.isVisible(), 8000), "closed and reopened: still a preview");
  check(await until(page, () => preview.isVisible()), "still no card after closing it");
  await page.waitForTimeout(700);

  // The whole rating system: each grade with its next interval, as /words.
  const IV = /\d+(s|m|h|d|mo|y)/;
  if (!touch) {
    const keys = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid=read-grade-keys] [data-rating]")].map(
        (e) => e.textContent,
      ),
    );
    check(
      keys.length === 4 && keys.every((k) => /\d+(s|m|h|d|mo|y)/.test(k ?? "")),
      `desktop: keys 1–4 with grade and interval (${JSON.stringify(keys)})`,
    );
  }
  {
    // Mid-drag: the hint names the grade and its interval; letting go short of a level cancels.
    const b0 = await knobBox(page);
    const x = b0.x + b0.width / 2;
    const y = b0.y + b0.height / 2;
    if (touch) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + i * 5.5, y }],
        });
        await page.waitForTimeout(16);
      }
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(x + i * 5.5, y);
        await page.waitForTimeout(16);
      }
    }
    await page.waitForTimeout(150);
    const hint = await page.getByTestId("read-grade-hint").textContent();
    check(/·/.test(hint ?? "") && IV.test(hint ?? ""), `mid-drag hint: grade · interval (${hint})`);
    await page.screenshot({ path: join(OUT, `dragging-${tag}.png`) });
    // Back to the middle before letting go: nothing graded.
    if (touch) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(120);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(x, y, { steps: 6 });
      await page.waitForTimeout(120);
      await page.mouse.up();
    }
    await page.waitForTimeout(300);
  }

  // Taps on the text and on the knob never grade.
  for (let i = 0; i < 3; i++) {
    await tapWord();
    await page.waitForTimeout(700);
  }
  await until(page, () => knob.isVisible());
  await page.waitForTimeout(600);
  const b = await knobBox(page);
  if (touch) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(400);
  check(
    !(await page
      .getByTestId("read-made-toast")
      .isVisible()
      .catch(() => false)) ||
      !(await page.getByTestId("read-made-toast").textContent()).includes(":"),
    "no grade toast after taps",
  );

  // A drag past the first level right: Good (mirror off), one batch after the hold.
  if (touch) await touchDrag(cdp, page, 56, 0);
  else await mouseDrag(page, 56, 0);
  const toast = page.getByTestId("read-made-toast");
  check(await until(page, () => toast.isVisible(), 2000), "the grade's compact toast");
  await page.screenshot({ path: join(OUT, `graded-${tag}.png`) });
  await page
    .getByTestId("read-grade-next")
    .waitFor({ timeout: 2000 })
    .catch(() => {});
  check(!(await preview.isVisible()), "committed: not a preview any more, nor a second commit");
  check(writes.length === 0, `held: nothing sent yet, and no tap graded (${writes.length})`);
  check(others.length === 0, `no make-cards before the commit (${others})`);
  check(await until(page, () => writes.length > 0, 12000), "the batch is sent after the hold");
  check(
    writes[0]?.rating === 3 && writes[0]?.words?.length === 1 && !writes[0]?.sentences?.length,
    `the batch: the word, Good (${JSON.stringify(writes[0]).slice(0, 160)})`,
  );
  await page.waitForTimeout(800);

  // Up: the batch is taken back by the server.
  await reopen();
  await until(page, () => knob.isVisible());
  await page.waitForTimeout(700);
  const undone = page.waitForResponse(
    (r) => r.url().includes("/batch-grade") && (r.request().postData() || "").includes('"undo"'),
    { timeout: 8000 },
  );
  if (touch) await touchDrag(cdp, page, 0, -70);
  else await mouseDrag(page, 0, -70);
  const u = await undone.catch(() => null);
  const ub = u ? await u.json().catch(() => null) : null;
  check(!!u && u.ok() && ub?.restored >= 1, `dragging up undoes it (${JSON.stringify(ub)})`);
  check(await until(page, () => preview.isVisible(), 8000), "undone: the card is gone, a preview");

  // The toast's Undo on a fresh commit: dropped while held, nothing sent.
  await page.waitForTimeout(700);
  const n1 = writes.length;
  if (touch) await touchDrag(cdp, page, 56, 0);
  else await mouseDrag(page, 56, 0);
  await toast.waitFor({ timeout: 2000 });
  await toast.locator("button").click();
  await page.waitForTimeout(GRADE_WAIT);
  check(writes.length === n1, "toast Undo while held: nothing sent");
  // A tap on the toast is a tap off the card, which closes: the word is still only a preview.
  await reopen();
  check(await until(page, () => preview.isVisible()), "toast Undo: a preview again");

  // Desktop: keys grade the open card's word.
  if (!touch) {
    await reopen();
    await until(page, () => knob.isVisible());
    await page.waitForTimeout(600);
    const before = writes.length;
    await page.keyboard.press("4");
    check(await until(page, () => toast.isVisible(), 2000), "key 4 grades the word (toast)");
    await page.keyboard.press("u");
    await page.waitForTimeout(GRADE_WAIT);
    check(writes.length === before, "U while held: dropped, nothing sent");

    // Without dragging: a focusable button per grade, shown on focus.
    await until(page, () => preview.isVisible());
    const good = page.locator("[data-testid=read-new-word-add][data-rating='3']");
    await good.focus();
    await page.screenshot({ path: join(OUT, `buttons-${tag}.png`) });
    const box = await good.boundingBox();
    check(box && box.height >= 40, `the focused button shows, full size (${box?.height})`);
    await page.keyboard.press("Enter");
    check(await until(page, () => toast.isVisible(), 2000), "Enter on the button commits (toast)");
    check(
      await until(
        page,
        () => page.evaluate(() => document.activeElement?.getAttribute("role") === "slider"),
        1500,
      ),
      "focus stays on the card (the knob)",
    );
    check(await until(page, () => writes.length > before, 12000), "its batch is sent");
    check(
      writes.at(-1)?.rating === 3,
      `the button's grade goes through (${writes.at(-1)?.rating})`,
    );
  }

  // A word with no meaning found (no model here): the word in its sentence.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
  const context = page.getByTestId("read-new-word-context");
  const spots = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=reader-book] [data-t][data-f="u"]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.top > 120 && r.bottom < innerHeight * 0.6 && r.width > 18)
      .slice(0, 8)
      .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })),
  );
  let shown = false;
  for (const p of spots) {
    if (touch) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(1200);
    shown = await context.isVisible();
    if (shown) {
      await page.screenshot({ path: join(OUT, `context-${tag}.png`) });
      break;
    }
    await page
      .getByTestId("read-select-close")
      .click()
      .catch(() => {});
    await page.waitForTimeout(800);
  }
  check(shown, `no meaning found: the word's sentence on the card (${spots.length})`);
  check(others.length === 0, `still no make-cards (${others})`);
  await page
    .getByTestId("read-select-close")
    .click()
    .catch(() => {});

  // A sentence: two quick clicks; its handle grades that sentence.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
  if (touch) {
    await page.touchscreen.tap(w.x, w.y);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(w.x, w.y);
  } else await page.mouse.click(w.x, w.y, { clickCount: 2, delay: 20 });
  await until(page, () =>
    page.evaluate(
      () => document.querySelector("[data-testid=read-select-card]")?.dataset.kind === "sentence",
    ),
  );
  check(
    await until(page, () =>
      page.evaluate(
        () => !!document.querySelector("[data-testid=read-grade-handle][data-enabled]"),
      ),
    ),
    "a sentence never graded: the handle is on",
  );
  await page.waitForTimeout(700);
  const n0 = writes.length;
  if (touch) await touchDrag(cdp, page, 56, 0);
  else await mouseDrag(page, 56, 0);
  check(await until(page, () => writes.length > n0, 12000), "the sentence's batch is sent");
  const sb = writes.at(-1);
  check(
    sb?.sentences?.length === 1 && !sb?.words?.length,
    `the batch: that sentence alone (${JSON.stringify(sb).slice(0, 160)})`,
  );
  await page.screenshot({ path: join(OUT, `sentence-${tag}.png`) });
  check(errs.length === 0, `no page errors (${errs.join(" | ").slice(0, 200)})`);
  await ctx.close();
}

const GRADE_WAIT = 9000;
await run(devices["Desktop Chrome"], "light", false);
await run(devices["iPhone 15"], "dark", true);
await run(devices["iPhone 15"], "light", true);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
