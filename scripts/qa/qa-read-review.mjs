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
// - ✕ closes it: the book is where it was;
// - a missed word coming back due never joins inside the viewport: with the
//   tail on screen it waits, nothing on screen moves; scrolled up, it joins
//   off screen (lib/words/requeue.ts offscreenSlot; a fake clock that runs).
// - the last card graded, by key or swipe, focuses 返回书本; Enter or G goes back;
// - the review is pinned in the URL (?review=): a reload opens it again on the
//   same card (the tab's sessionStorage), and Back closes it on the book.
//
// - a row near the screen fills itself: a new word's meaning, its example's
//   translation; never the whole list, each word once (the model stubbed at the routes).
//
// The reader v2 needs `?reader=v2` on a dev server, or the read.reader-v2
// flag on in the local D1 for wrangler dev.
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
      if (r.top < 120 || r.bottom > innerHeight * 0.7) continue;
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
  // A single new word has its slider, not a button (reader-grade-handle.tsx NewWordStrip).
  check(!acts.some(([a]) => a === "make-cards"), "a word's card has no 制卡 button");
  check(
    acts.some(([a]) => a === "review-words"),
    `the word's card offers the review (${acts.map((a) => a[0])})`,
  );
  // Its sentence: 制卡 for its several words. A quick second tap widens the selection.
  await click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=read-select-card]")?.dataset.kind === "sentence",
  );
  await page.waitForTimeout(300);
  acts = await actions(page);
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
  // The card's word is highlighted in its sentence, and a long sentence's
  // cell is scrolled so the word is inside it (lib/words/example-target.ts).
  await page.waitForTimeout(300);
  const aim = await page.evaluate(() => {
    const exs = [...document.querySelectorAll("[data-testid=read-word-review] [data-row-example]")];
    let marked = 0;
    let hidden = 0;
    let scrolled = 0;
    for (const ex of exs) {
      const m = ex.querySelector("[data-ex-target]");
      if (!m) continue;
      marked++;
      let cell = ex.parentElement;
      while (cell && getComputedStyle(cell).overflow !== "hidden") cell = cell.parentElement;
      if (!cell) continue;
      if (cell.scrollTop || cell.scrollLeft) scrolled++;
      const a = m.getClientRects()[0];
      const c = cell.getBoundingClientRect();
      if (!a || a.bottom <= c.top || a.top >= c.bottom || a.right <= c.left || a.left >= c.right)
        hidden++;
    }
    return { examples: exs.length, marked, hidden, scrolled };
  });
  check(
    aim.marked > 0 && aim.hidden === 0,
    `each example's word is highlighted and in view (${JSON.stringify(aim)})`,
  );
  // Several new words: the batch 制卡 stays at the top (one alone has only its swipe).
  const makeTop = page.getByTestId("read-review-make");
  check(await makeTop.isVisible(), "the batch 制卡 at the top of the review");
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

  // The tray after the last word is the way back to the book, labelled as the
  // toolbar's exit (the owner, 2026-11-05: never a dead end at the end).
  const tray = page.getByTestId("study-done-back");
  const trayText = (await tray.count()) === 1 ? (await tray.textContent()).trim() : null;
  const exitText = await page
    .locator("[data-words-top] button")
    .first()
    .textContent()
    .then((s) => s.trim());
  check(
    !!trayText && trayText === exitText,
    `the end of the list is a way back, as the exit ("${trayText}" / "${exitText}")`,
  );
  // Close: the book where it was. On touch through the tray, else ✕.
  if (touch && trayText) {
    await tray.scrollIntoViewIfNeeded();
    await tray.click();
  } else await page.getByTestId("read-review-close").click();
  await page.waitForTimeout(400);
  check(
    !(await page.getByTestId("read-word-review").count()),
    `${touch && trayText ? "the end tray" : "✕"} closes the review`,
  );
  const y1 = await page.evaluate(() => scrollY);
  check(Math.abs(y1 - y0) < 40, `the book kept its place (${y0} → ${y1})`);
  check(!new URL(page.url()).searchParams.has("review"), `✕ drops ?review= (${page.url()})`);

  // Reload in the review: the same review, on the same card (owner, 2026-11-05).
  await click();
  await page.waitForTimeout(300);
  await page.locator("[data-action=review-words]").click();
  await page.getByTestId("read-word-review").waitFor();
  await until(page, async () => (await rows.count()) > 2);
  const ref = new URL(page.url()).searchParams.get("review");
  check(/^p\d+$/.test(ref ?? ""), `the review is in the URL (?review=${ref})`);
  // Move the focus to the third card: a tap (touch), the cursor keys (desktop).
  if (touch) {
    // A tap while the list still moves is a scroll's end, not a tap: let it rest.
    await page.waitForTimeout(1200);
    // A row in the middle of the screen, clear of the bands over the list.
    const p = await page.evaluate(() => {
      for (const r of document.querySelectorAll("[data-testid=read-word-review] [data-i]")) {
        const b = r.getBoundingClientRect();
        const y = b.top + b.height / 2;
        if (y > innerHeight * 0.45 && y < innerHeight * 0.75 && !r.querySelector(".slip-loose"))
          return { x: b.left + b.width / 2, y };
      }
      return null;
    });
    if (p) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
      await page.waitForTimeout(60);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } else {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
  }
  const focused = () =>
    page.evaluate(
      () =>
        document.querySelector(
          "[data-testid=read-word-review] .slip-loose bdi:not([data-row-example])",
        )?.textContent ?? null,
    );
  const first = await page.evaluate(
    () =>
      document.querySelector(
        "[data-testid=read-word-review] [data-i='0'] bdi:not([data-row-example])",
      )?.textContent ?? null,
  );
  let before = null;
  await until(page, async () => !!(before = await focused()) && before !== first, 4000);
  check(!!before && before !== first, `the focus moved off the first card (${first} → ${before})`);
  // The position is written as it changes; give the store a beat.
  await page.waitForTimeout(400);
  const entries = await page.evaluate(() => history.length);
  await page.reload({ waitUntil: "load" });
  check(
    await until(page, async () => (await page.getByTestId("read-word-review").count()) > 0, 20000),
    "a reload opens the review again",
  );
  check(new URL(page.url()).searchParams.get("review") === ref, "on the same ?review=");
  let after = null;
  await until(page, async () => (after = await focused()) === before, 15000);
  check(after === before, `on the same card (${before} → ${after})`);
  check((await page.evaluate(() => history.length)) === entries, "no extra history entry");
  await page.screenshot({ path: join(OUT, `reloaded-${tag}.png`) });
  // Back closes it on the book, the reader still there.
  await page.goBack();
  check(
    await until(page, async () => !(await page.getByTestId("read-word-review").count())),
    "Back closes the reloaded review",
  );
  check(
    !new URL(page.url()).searchParams.has("review") && /\/read\//.test(page.url()),
    `Back lands on the book (${page.url()})`,
  );
  check(await page.getByTestId("reader-v2").isVisible(), "the reader is under it");
  check(errs.length === 0, `no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

/**
 * A missed card comes back due, never into the viewport (the owner,
 * 2026-11-05): scrolled to the end, the tail is on screen, so it waits —
 * nothing on screen moves. Scrolled back up, it joins off screen.
 */
async function offscreenInsert(device) {
  const tag = "insert-desktop";
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: "light" });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag);
  // A fake clock that still runs, from here on (the book loads on the real
  // one): fastForward makes the missed card due.
  await page.clock.install();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(600);
  const w = await aWord(page);
  check(!!w, `${tag}: a word in a long paragraph is on screen`);
  if (!w) return ctx.close();
  await page.mouse.click(w.x, w.y);
  await page.waitForTimeout(300);
  await page.locator("[data-action=review-words]").click();
  const list = page.locator("[data-testid=read-word-review] [role=list]");
  const rows = list.locator("[data-i]");
  await until(page, async () => (await rows.count()) > 0);
  // Again on the first word: its copy is due within minutes.
  const graded = page.waitForResponse((r) => /\/api\/words\/lists\/[^/]+\/review/.test(r.url()));
  await page.keyboard.press("Digit1");
  await graded.catch(() => null);
  // The cursor to the last word, then the list to its end: the tail is on screen.
  for (let i = 0; i < 60; i++) await page.keyboard.press("KeyS");
  const snap = () =>
    list.evaluate((el) => {
      const v = el.getBoundingClientRect();
      const seen = [...el.querySelectorAll("[data-i]")]
        .map((r) => [r, r.getBoundingClientRect()])
        .filter(([, b]) => b.bottom > v.top && b.top < v.bottom)
        .map(([r, b]) => `${r.dataset.i}:${Math.round(b.top)}:${r.textContent.slice(0, 24)}`);
      return {
        h: el.scrollHeight,
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
        seen,
      };
    });
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(800);
  const atEnd = await snap();
  check(atEnd.top >= atEnd.max - 1, `${tag}: scrolled to the end (${atEnd.top}/${atEnd.max})`);
  // Due now; the hand rests (> 400 ms), the copy has nowhere off screen to go.
  await page.clock.fastForward("05:00");
  await page.waitForTimeout(1200);
  const waited = await snap();
  check(
    waited.h === atEnd.h,
    `${tag}: with the tail on screen nothing is inserted (${atEnd.h} → ${waited.h})`,
  );
  check(
    JSON.stringify(waited.seen) === JSON.stringify(atEnd.seen) && waited.top === atEnd.top,
    `${tag}: the rows on screen did not move (${atEnd.seen.length} rows)`,
  );
  await page.screenshot({ path: join(OUT, `insert-waiting.png`) });
  // Back to the top: the tail is off screen, the copy joins there.
  await list.evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(150);
  const up = await snap();
  await page.waitForTimeout(1200);
  const after = await snap();
  check(after.h > up.h, `${tag}: scrolled up, the copy joins the list (${up.h} → ${after.h})`);
  check(
    JSON.stringify(after.seen) === JSON.stringify(up.seen) && after.top === up.top,
    `${tag}: off screen — the rows on screen stay as they were`,
  );
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

/**
 * The last card graded: focus goes to the end-of-list way back (返回书本), it
 * looks focused, a polite status says so, and Enter or G goes back to the book
 * (the owner, 2026-11-05 13:37 JST; 2026-11-06, 2026-11-07). Whatever the grade:
 * a miss's copy waiting to come back does not hold the end. G does nothing
 * before that, or in a field. A correction afterwards never pulls the focus.
 *
 * `last`: the key for the last card, or null to swipe every card (touch).
 * `leave`: the key that goes back.
 */
async function lastCardBack(device, { scheme = "light", last, leave }) {
  const tag = `last-card-${last ?? "swipe"}-${leave}-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: scheme });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(600);
  const w = await aWord(page);
  check(!!w, `${tag}: a word in a long paragraph is on screen`);
  if (!w) return ctx.close();
  if (last) await page.mouse.click(w.x, w.y);
  else await page.touchscreen.tap(w.x, w.y);
  await page.waitForTimeout(300);
  await page.locator("[data-action=review-words]").click();
  const list = page.locator("[data-testid=read-word-review] [role=list]");
  const rows = list.locator("[data-i]");
  await until(page, async () => (await rows.count()) > 0);
  await page.waitForTimeout(400);
  // The rows are windowed: the count is the last row's index, scrolled to the end.
  const n = await list.evaluate(async (el) => {
    el.scrollTop = el.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    const last = Math.max(...[...el.querySelectorAll("[data-i]")].map((r) => +r.dataset.i));
    el.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 300));
    return last + 1;
  });
  const onBack = () =>
    page.evaluate(() => document.activeElement?.dataset?.testid === "study-done-back");
  const open = async () => (await page.getByTestId("read-word-review").count()) > 0;
  const cdp = last ? null : await ctx.newCDPSession(page);
  /** One finger across row i, as /words' swipe; the list then moves the next one up. */
  const swipe = async (i) => {
    const row = list.locator(`[data-i="${i}"]`);
    await row.waitFor();
    await page.waitForTimeout(500);
    const b = await row.boundingBox();
    const y = b.y + b.height / 2;
    const x = b.x + 60;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let d = 1; d <= 12; d++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + d * 12, y }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // Easy on every card but the last (Easy: days away, nothing comes back).
  for (let i = 0; i < n - 1; i++) {
    if (last) await page.keyboard.press("Digit4");
    else await swipe(i);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  check(!(await onBack()), `${tag}: one card of ${n} left, the focus stays on the list`);
  await page.keyboard.press("KeyG");
  await page.waitForTimeout(200);
  check(await open(), `${tag}: G does nothing before the list is done`);
  if (last) await page.keyboard.press(last);
  else await swipe(n - 1);
  check(await until(page, onBack, 3000), `${tag}: the last card graded, focus on 返回书本`);
  const said = await page.evaluate(
    () => document.querySelector("[data-review-ended]")?.textContent ?? "",
  );
  check(said.length > 0, `${tag}: a polite status says so ("${said}")`);
  // Let the list come to rest.
  await page.waitForTimeout(700);
  const seen = await page.evaluate(() => {
    const b = document.activeElement.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight;
  });
  check(seen, `${tag}: the button is scrolled into view`);
  const look = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  check(/oklch|rgb|lab/.test(look), `${tag}: it looks focused, however it got there (${look})`);
  await page.screenshot({ path: join(OUT, `${tag}.png`) });

  if (last) {
    // A correction when all are done: the focus is not pulled back to it.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Digit3");
    await page.waitForTimeout(500);
    check(!(await onBack()), `${tag}: a correction does not move the focus to 返回书本`);
    await page.getByTestId("study-done-back").focus();
  }
  // In a field G is a letter.
  await page.evaluate(() => {
    const f = document.createElement("input");
    f.id = "qa-field";
    document.querySelector("[data-testid=read-word-review]").append(f);
    f.focus();
  });
  await page.keyboard.press("KeyG");
  await page.waitForTimeout(200);
  check(
    (await open()) && (await page.inputValue("#qa-field")) === "g",
    `${tag}: G in a field stays a letter`,
  );
  await page.evaluate(() => document.getElementById("qa-field").remove());
  await page.getByTestId("study-done-back").focus();
  // Back on the button, Enter or G goes back to the book.
  await page.keyboard.press(leave);
  check(
    await until(page, async () => !(await open())),
    `${tag}: ${leave} on 返回书本 closes the review`,
  );
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

/** Plain /words has the same end: the same focus, its own label, G goes back to the lists. */
async function plainWordsBack(device) {
  const tag = "plain-words";
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: "light" });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs, id } = await setup(ctx, tag);
  const made = await page.evaluate(async (id) => {
    const ws = [...document.querySelectorAll(".lk-book [data-t]")]
      .map((e) => e.textContent.trim().toLowerCase())
      .filter((w) => /^[a-z]{4,}$/.test(w));
    const words = [...new Set(ws)].slice(0, 4).map((w) => ({ w, ex: `QA ${w}.`, back: "qa" }));
    const r = await fetch(`/api/read/${id}/make-cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ words }),
    });
    return r.json();
  }, id);
  check(made.terms?.length > 1 && !!made.listId, `${tag}: a small list (${made.terms?.length})`);
  await page.goto(`/words?list=${made.listId}`, { waitUntil: "networkidle" });
  const rows = page.locator('[role="list"] [data-i]');
  await rows.first().waitFor({ timeout: 15000 });
  const n = made.terms.length;
  const onBack = () =>
    page.evaluate(() => document.activeElement?.dataset?.testid === "study-done-back");
  for (let i = 0; i < n - 1; i++) {
    await page.keyboard.press("Digit4");
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("KeyG");
  await page.waitForTimeout(200);
  check(page.url().includes("list="), `${tag}: G does nothing before the list is done`);
  await page.keyboard.press("Digit3");
  check(await until(page, onBack, 8000), `${tag}: the last card graded, focus on the way back`);
  const label = await page.evaluate(() => document.activeElement.textContent.trim());
  check(label === "← lists", `${tag}: it is its own way back ("${label}")`);
  await page.screenshot({ path: join(OUT, `${tag}.png`) });
  await page.keyboard.press("KeyG");
  check(
    await until(page, async () => !new URL(page.url()).searchParams.has("list")),
    `${tag}: G goes back to the lists (${page.url()})`,
  );
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

/**
 * A review list's rows fill themselves as they come near the screen: a new word's
 * meaning (owner, 2026-11-06 23:07 JST: "gain/issues have no explaination") and
 * the example's translation (2026-11-07 16:39), never the whole list on opening,
 * each word once, and the swipe's commit carries the meaning. The model is
 * stubbed at the routes: this checks what the page asks and shows, not a model.
 */
async function rowsFill(device, scheme, touch) {
  const tag = `fill-${touch ? "iphone" : "desktop"}-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: scheme });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs, id } = await setup(ctx, tag);
  const glossed = [];
  const translated = [];
  const graded = [];
  let failing = null;
  await ctx.route("**/api/read/*/gloss", (r) => {
    const { w } = r.request().postDataJSON();
    glossed.push(w);
    if (w === failing) return r.fulfill({ status: 500, body: "{}" });
    return r.fulfill({ json: { term: w, back: `QA meaning of ${w}` } });
  });
  await ctx.route("**/api/read/*/translate", (r) => {
    const { text } = r.request().postDataJSON();
    translated.push(text);
    return r.fulfill({ json: { text: `译文：${text.slice(0, 40)}`, cached: false } });
  });
  // Every word new with no meaning, so each row has something to ask for
  // (a local deck may know some); the first of them fails.
  await ctx.route("**/api/read/*/word-session", async (r) => {
    const body = r.request().postDataJSON();
    if (body.graded) {
      graded.push(...body.graded);
      return r.fallback();
    }
    const res = await r.fetch();
    const json = await res.json();
    for (const it of json.items) if (!it.card) it.back = "";
    failing = json.items.find((it) => !it.card)?.w ?? null;
    return r.fulfill({ response: res, json });
  });
  // Every back shown, so the screenshots show what a row holds when focused.
  await page.evaluate(() => localStorage.setItem("lk:words-show-all", "1"));
  // His language is not the book's: the address gives it.
  await page.goto(`/zh/read/${id}?reader=v2`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(800);
  const w = await aWord(page);
  check(!!w, `${tag}: a word in a long paragraph is on screen`);
  if (!w) return ctx.close();
  if (touch) await page.touchscreen.tap(w.x, w.y);
  else await page.mouse.click(w.x, w.y);
  await page.waitForTimeout(300);
  await page.locator("[data-action=review-words]").click();
  const list = page.locator("[data-testid=read-word-review] [role=list]");
  await until(page, async () => (await list.locator("[data-i]").count()) > 0);
  await until(page, async () => translated.length > 0, 5000);
  await page.waitForTimeout(1200);
  const n = await list.evaluate(async (el) => {
    const top = el.scrollTop;
    el.scrollTop = 0;
    const h = parseFloat(getComputedStyle(el.querySelector("[data-i]")).height) || 40;
    el.scrollTop = top;
    return Math.round(el.scrollHeight / h);
  });
  const atOpening = { gloss: glossed.length, trans: translated.length };
  check(
    atOpening.gloss > 0 && atOpening.gloss <= 26,
    `${tag}: opening asks meanings only near the screen (${atOpening.gloss} of about ${n} rows)`,
  );
  check(
    atOpening.trans > 0 && atOpening.trans <= 26,
    `${tag}: and translations only near the screen (${atOpening.trans})`,
  );
  check(
    new Set(glossed).size === glossed.length,
    `${tag}: no word asked twice (${glossed.length} asks)`,
  );
  const shown = await page.evaluate(() => ({
    meaning: document.querySelectorAll("[data-testid=read-word-review] [data-i]").length,
    tr: document.querySelector("[data-row-ex-tr]")?.textContent ?? "",
    none: document.querySelectorAll("[data-row-meaning=none]").length,
    meanings: [...document.querySelectorAll("[data-testid=read-word-review] [data-i]")].filter(
      (r) => r.textContent.includes("QA meaning of"),
    ).length,
  }));
  check(shown.tr.startsWith("译文："), `${tag}: a row shows its example's translation`);
  check(shown.meanings > 0, `${tag}: rows show their meaning (${shown.meanings})`);
  check(shown.none === 1, `${tag}: the failed lookup reads calmly (${shown.none})`);
  // The translation has its own line, inside the row.
  const fits = await page.evaluate(() => {
    const t = document.querySelector("[data-row-ex-tr]");
    const r = t.closest("[data-i]").getBoundingClientRect();
    const b = t.getBoundingClientRect();
    return b.height > 0 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
  });
  check(fits, `${tag}: its line fits in the row`);
  await page.screenshot({ path: join(OUT, `${tag}.png`) });

  // Further down: more asks, and not everything at once.
  const before = glossed.length;
  await list.evaluate((el) => {
    el.scrollTop += el.clientHeight * 2;
  });
  await until(page, async () => glossed.length > before, 5000);
  await page.waitForTimeout(800);
  check(glossed.length > before, `${tag}: scrolling asks for the rows it reaches`);
  check(
    new Set(glossed).size === glossed.length,
    `${tag}: still no word asked twice (${glossed.length} asks)`,
  );
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(800);

  // The failed row still grades; the next row's commit carries its meaning.
  const asks = glossed.length;
  const grade = async (i) => {
    if (!touch) return page.keyboard.press("Digit3");
    const cdp = await ctx.newCDPSession(page);
    const b = await list.locator(`[data-i="${i}"]`).boundingBox();
    const y = b.y + b.height / 2;
    const x = b.x + 60;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let d = 1; d <= 12; d++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + d * 12, y }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await grade(0);
  await page.waitForTimeout(700);
  await grade(1);
  check(
    await until(page, async () => graded.length >= 2, 8000),
    `${tag}: the row with no meaning and the next both grade (${graded.length})`,
  );
  const failed = graded.find((g) => g.w === failing);
  const other = graded.find((g) => g.w !== failing);
  check(!!failed && !failed.back, `${tag}: the failed word commits with no meaning to carry`);
  check(
    other?.back === `QA meaning of ${other?.w}`,
    `${tag}: the commit carries the row's meaning (${other?.back})`,
  );
  check(glossed.length === asks, `${tag}: and asks for nothing again`);
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

/** His language is the book's: no translation is asked for. */
async function noTranslationInOwnLanguage(device) {
  const tag = "fill-own-language";
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE, colorScheme: "light" });
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const { page, errs } = await setup(ctx, tag);
  let asked = 0;
  await ctx.route("**/api/read/*/translate", (r) => {
    asked++;
    return r.fulfill({ json: { text: "x", cached: false } });
  });
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(800);
  const w = await aWord(page);
  await page.mouse.click(w.x, w.y);
  await page.waitForTimeout(300);
  await page.locator("[data-action=review-words]").click();
  const rows = page.locator("[data-testid=read-word-review] [role=list] [data-i]");
  await until(page, async () => (await rows.count()) > 0);
  const before = asked;
  await page.waitForTimeout(1500);
  check(asked === before, `${tag}: an English sentence for an English reader asks nothing`);
  check((await page.locator("[data-row-ex-tr]").count()) === 0, `${tag}: and shows no line for it`);
  check(errs.length === 0, `${tag}: no page errors (${errs.slice(0, 2)})`);
  await ctx.close();
}

await rowsFill(devices["Desktop Chrome"], "light", false);
await rowsFill(devices["Desktop Chrome"], "dark", false);
await rowsFill(devices["iPhone 13"], "light", true);
await rowsFill(devices["iPhone 13"], "dark", true);
// QA_ONLY=fill: just the rows filling themselves.
if (process.env.QA_ONLY !== "fill") {
  await noTranslationInOwnLanguage(devices["Desktop Chrome"]);
  await plainWordsBack(devices["Desktop Chrome"]);
  // Easy (nothing comes back), and Again and Good (a copy waits): the same end.
  await lastCardBack(devices["Desktop Chrome"], { last: "Digit4", leave: "Enter" });
  await lastCardBack(devices["Desktop Chrome"], { last: "Digit1", leave: "KeyG" });
  await lastCardBack(devices["Desktop Chrome"], { last: "Digit3", leave: "KeyG", scheme: "dark" });
  await lastCardBack(devices["iPhone 13"], { leave: "KeyG" });
  await lastCardBack(devices["iPhone 13"], { leave: "Enter", scheme: "dark" });
  await offscreenInsert(devices["Desktop Chrome"]);
  await run(devices["iPhone 13"], "light", true);
  await run(devices["iPhone 13"], "dark", true);
  await run(devices["Desktop Chrome"], "light", false);
}
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
