// /read reader v2: combo-click expanding selection and deep links QA
// (docs/books-plan.md, "Combo-click expanding selection"). Silent; iPhone and
// desktop, light and dark screenshots.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-read-select.mjs [outDir]
//
// Against a local dev server on D1 (`DB_BACKEND=d1 next dev`, or qa:all's
// wrangler dev) so books carry their content hash. Signs up throwaway
// accounts and imports the public-domain fixture EPUB, never anyone's book:
//
// - a click selects a word; quick extra clicks widen it (word → sentence →
//   paragraph → chapter → book; no phrase data yet, so no phrase level);
//   native double/triple-click selects no DOM text; a pause starts over;
// - one glass card per level, with its actions and the link button;
// - the link copies /read/<content hash>#<unit>; opening it scrolls to the
//   unit, flashes it and shows its card; back closes the card;
// - another account (and a signed-out visitor) get 404 for the same link;
// - a sideways swipe grades and never selects; a tap elsewhere clears;
// - a sentence and a paragraph translate by themselves on the card (the
//   translate API is answered here, no model), each unit asked for once.
//
// No sound: speechSynthesis is a fake (on top of silent.mjs).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-select";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const FAKE_SPEECH = `(() => {
  const spoken = (window.__spoken = []);
  let timers = [];
  const fake = {
    speaking: false,
    getVoices: () => [{ lang: "en-US", name: "QA voice", voiceURI: "qa", default: true, localService: true }],
    speak(u) {
      spoken.push(u.text);
      timers.push(setTimeout(() => u.onstart && u.onstart(), 10));
      timers.push(setTimeout(() => u.onend && u.onend(), 200));
    },
    cancel() { timers.forEach(clearTimeout); timers = []; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: fake });
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ""; this.voice = null; this.rate = 1; this.onstart = this.onend = this.onerror = null; }
  };
})();`;

const until = async (page, f, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(50);
  }
  return false;
};

async function drag(cdp, x0, y0, x1, y1, steps = 12, ms = 16) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: x0, y: y0 }],
  });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await new Promise((r) => setTimeout(r, ms));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Quick taps at one point (real touch events), `gap` ms apart. */
async function taps(cdp, x, y, n, gap = 60) {
  for (let i = 0; i < n; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    if (i < n - 1) await new Promise((r) => setTimeout(r, gap));
  }
}

const browser = await launchSilent(chromium);

async function signUp(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+select-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Select" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
}

/** A word on screen, well inside the reading area: its point and address. */
const aWord = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector("[data-reader-strip] > div")?.getBoundingClientRect();
    const minTop = (strip?.bottom ?? 0) + 20;
    for (const el of document.querySelectorAll("[data-testid=reader-book] p[data-line] [data-t]")) {
      const r = el.getBoundingClientRect();
      if (r.top < minTop || r.bottom > innerHeight * 0.45 || r.width < 18) continue;
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        line: Number(el.closest("[data-line]").dataset.line),
        t: Number(el.dataset.t),
        s: Number(el.closest("[data-s]").dataset.s),
        text: el.textContent.trim(),
        sentence: el.closest("[data-s]").textContent.replace(/\s+/g, " ").trim(),
        para: el.closest("[data-line]").textContent.replace(/\s+/g, " ").trim(),
      };
    }
    return null;
  });

const card = (page) =>
  page.evaluate(() => {
    const c = document.querySelector("[data-testid=read-select-card]");
    if (!c) return null;
    return {
      kind: c.dataset.kind,
      actions: [...c.querySelectorAll("[data-action]")].map((b) => b.dataset.action),
      link: !!c.querySelector("[data-testid=read-select-link] svg path"),
      title: c.querySelector("[data-testid=read-select-title]")?.textContent ?? null,
      size: c.querySelector("[data-testid=read-select-size]")?.textContent ?? null,
      fam: !!c.querySelector("[data-testid=read-select-fam]"),
      ranges: document.querySelectorAll(".lk-book [data-sel]").length,
      domSel: getSelection()?.toString() ?? "",
      bg: getComputedStyle(c).backdropFilter || getComputedStyle(c).webkitBackdropFilter,
    };
  });

async function open(ctx) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/read", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL(/\/read\/[^/?]+$/, { timeout: 30000 });
  const id = page.url().split("/").pop();
  await page.goto(`/read/${id}`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor();
  await page.waitForTimeout(800);
  return { page, errs, id };
}

/** Answers the translate API without a model, and counts what it was asked. */
async function fakeTranslate(ctx) {
  const asked = [];
  await ctx.route("**/api/read/*/translate", async (r) => {
    const { text } = JSON.parse(r.request().postData() || "{}");
    asked.push(text);
    await r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: `«${text.slice(0, 12)}»`, cached: false }),
    });
  });
  return asked;
}

const translationShown = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-testid=read-select-translation]");
    return el && !el.dataset.pending ? el.textContent.trim() : null;
  });

async function desktop(scheme) {
  const tag = `desktop-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, {
    ...devices["Desktop Chrome"],
    baseURL: BASE,
    colorScheme: scheme,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  const asked = await fakeTranslate(ctx);
  await signUp(ctx, tag);
  const { page, errs, id } = await open(ctx);
  const w = await aWord(page);
  check(!!w, "a word is on screen");
  if (!w) return ctx.close();

  // One click: the word.
  await page.mouse.click(w.x, w.y);
  await page.waitForTimeout(150);
  let c = await card(page);
  check(c?.kind === "word", `a click selects the word (${c?.kind})`);
  check(!!c?.link, "the card has the link button (inline SVG)");
  check(
    !c?.actions.includes("lookup") && c?.actions.includes("copy-text"),
    `word actions: copy is an icon, no look-up (${c?.actions})`,
  );
  check((c?.ranges ?? 0) > 0, "the word is highlighted");
  check(!!c?.bg && c.bg !== "none", "the card is glass (backdrop-filter)");
  await page.screenshot({ path: join(OUT, `select-word-${tag}.png`) });
  // Owner 22:12 JST: a tapped word says that word alone, not its sentence.
  await page.waitForTimeout(500);
  let spoken = await page.evaluate(() => window.__spoken.splice(0));
  check(
    spoken.length === 1 && spoken[0] === w.text,
    `a click says the word alone (${JSON.stringify(spoken)})`,
  );

  // Each level says its own unit; the levels a fast combo passes are not said.
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 2, delay: 20 });
  await page.waitForTimeout(800);
  spoken = await page.evaluate(() => window.__spoken.splice(0));
  check(
    spoken[0] === w.text && spoken.slice(1).join(" ") === w.sentence,
    `a double-click says the sentence (${JSON.stringify(spoken)})`,
  );
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 3, delay: 20 });
  await page.waitForTimeout(400 + 200 * (w.para.length / 40));
  spoken = await page.evaluate(() => window.__spoken.splice(0));
  check(
    spoken[0] === w.text && spoken.slice(1).join(" ") === w.para,
    `a triple-click says the paragraph, not the sentence on the way (${JSON.stringify(spoken).slice(0, 120)})`,
  );
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 5, delay: 20 });
  await page.waitForTimeout(800);
  spoken = await page.evaluate(() => window.__spoken.splice(0));
  check(
    spoken.length <= 1,
    `the book (5 clicks) is not read on a tap (${JSON.stringify(spoken).slice(0, 80)})`,
  );

  // A word tapped during playback: the book pauses and stays paused, the word is said.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 300);
  await page.waitForTimeout(500);
  await page.getByTestId("read-play").click();
  await until(page, () => page.evaluate(() => window.__spoken.length > 0), 3000);
  const w2 = await aWord(page);
  await page.evaluate(() => window.__spoken.splice(0));
  await page.mouse.click(w2.x, w2.y);
  await page.waitForTimeout(1200);
  // (A line the player began just before the click may come first.)
  spoken = await page.evaluate(() => window.__spoken.splice(0));
  const st = await page.getByTestId("read-play").getAttribute("data-status");
  check(
    st === "idle" && spoken[spoken.length - 1] === w2.text,
    `a tap during playback pauses it and says the word last (${st}, ${JSON.stringify(spoken).slice(-60)})`,
  );
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => window.__spoken.splice(0));
  check(after.length === 0, `and the book stays paused (${JSON.stringify(after).slice(0, 60)})`);

  // A pause, then a triple-click: word → sentence → paragraph, no DOM text selected.
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 3, delay: 20 });
  await page.waitForTimeout(150);
  c = await card(page);
  check(c?.kind === "para", `a triple-click selects the paragraph (${c?.kind})`);
  check(c?.domSel === "", `no native selection (${JSON.stringify(c?.domSel?.slice(0, 20))})`);
  check(c?.actions.includes("read-from"), `paragraph actions (${c?.actions})`);
  // The paragraph translates by itself, as its whole sentences (owner, 2026-11-06).
  const paraTr = await until(page, async () => !!(await translationShown(page)), 5000);
  check(
    paraTr &&
      asked.some((t) => t.replace(/\s+/g, " ").trim() === w.sentence) &&
      asked.every((t) => w.para.includes(t.replace(/\s+/g, " ").trim())),
    `the paragraph is translated by itself, sentence by sentence (${asked.length} asked)`,
  );
  // The word map arrives on its own after the book: wait for it.
  const famShown = await until(
    page,
    () => page.evaluate(() => !!document.querySelector("[data-testid=read-select-fam]")),
    5000,
  );
  check(famShown, "the paragraph shows its familiarity");
  await page.screenshot({ path: join(OUT, `select-para-${tag}.png`) });

  // Five quick clicks: up to the book (a virtual selection).
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 5, delay: 20 });
  await page.waitForTimeout(200);
  c = await card(page);
  check(c?.kind === "book", `five quick clicks select the book (${c?.kind})`);
  check(!!c?.title && !!c?.size, `the book card has its title and size (${c?.title} · ${c?.size})`);
  check(c?.domSel === "", "the book is a virtual selection (no DOM selection)");
  await page.screenshot({ path: join(OUT, `select-book-${tag}.png`) });

  // Four: the chapter.
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 4, delay: 20 });
  await page.waitForTimeout(200);
  c = await card(page);
  check(c?.kind === "chapter" || c?.kind === "book", `four quick clicks: the chapter (${c?.kind})`);

  // Two: the sentence; the link copies /read/<hash>#s=<line>.<sentence>.
  await page.waitForTimeout(700);
  await page.mouse.click(w.x, w.y, { clickCount: 2, delay: 20 });
  await page.waitForTimeout(150);
  c = await card(page);
  check(c?.kind === "sentence", `a double-click selects the sentence (${c?.kind})`);
  const sentTr = await until(page, async () => !!(await translationShown(page)), 5000);
  check(
    sentTr && asked.some((t) => t.replace(/\s+/g, " ").trim() === w.sentence),
    "the sentence is translated by itself",
  );
  check(
    !c?.actions.includes("translate"),
    `no Translate tap needed for a sentence (${c?.actions})`,
  );
  await page.waitForTimeout(150);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check(
    new RegExp(`/read/[0-9a-f]{16}#s=${w.line}\\.${w.s}$`).test(link),
    `the link names the book's hash and the sentence (${link})`,
  );
  check(
    (await page
      .getByTestId("read-select-status")
      .textContent()
      .catch(() => "")) !== "",
    "the card confirms the copy",
  );

  // Back closes the card, the page stays.
  const url = page.url();
  await page.goBack();
  await page.waitForTimeout(300);
  check(
    (await card(page)) === null && page.url().split("#")[0] === url.split("#")[0],
    "back closes the card",
  );

  // Read from here (a sentence) — selected again: its translation is not asked for again.
  const before = asked.length;
  await page.mouse.click(w.x, w.y, { clickCount: 2, delay: 20 });
  await page.waitForTimeout(150);
  check(
    !!(await until(page, async () => !!(await translationShown(page)), 3000)) &&
      asked.length === before,
    `a sentence translated once is not asked for again (${asked.length - before} more)`,
  );
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__spoken.splice(0));
  await page.locator('[data-testid=read-select-card] [data-action="read-from"]').click();
  const spoke = await until(page, () => page.evaluate(() => window.__spoken.length > 0), 3000);
  check(spoke, "read from here starts read-aloud");
  await page.getByTestId("read-play").click();

  // A click elsewhere clears it.
  await page
    .locator("[data-reader-chapter]")
    .click()
    .catch(() => {});
  await page.waitForTimeout(200);
  if (await card(page)) await page.mouse.click(4, 300);
  await page.waitForTimeout(200);
  check((await card(page)) === null, "a click elsewhere clears the selection");

  // The deep link opens at the unit, flashed, its card shown.
  const u = new URL(link);
  const linkPage = await ctx.newPage();
  await linkPage.goto(`${u.pathname}${u.hash}`, { waitUntil: "load" });
  await linkPage.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  const landed = await until(
    linkPage,
    () => linkPage.evaluate(() => !!document.querySelector("[data-testid=read-select-card]")),
    6000,
  );
  check(landed, "a deep link opens its card");
  check(
    !/[0-9a-f]{16}/.test(new URL(linkPage.url()).pathname) &&
      linkPage.url().includes(`/read/${id}`) &&
      linkPage.url().endsWith(u.hash),
    `the hash path redirects to his copy, keeping the fragment (${linkPage.url()})`,
  );
  const at = await linkPage.evaluate(
    ({ line, s }) => {
      const el = document.querySelector(`[data-line="${line}"] [data-s="${s}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, flash: !!document.querySelector("[data-flash]") };
    },
    { line: w.line, s: w.s },
  );
  check(
    !!at && at.top < innerHeightOf(linkPage) && at.bottom > 0,
    "the linked sentence is on screen",
  );
  check(!!at?.flash, "the linked unit flashes");
  check((await card(linkPage))?.kind === "sentence", "its card is the sentence's");
  await linkPage.screenshot({ path: join(OUT, `select-deeplink-${tag}.png`) });

  // Access: the owner's API gets a redirect, others 404.
  const own = await ctx.request.get(`${u.pathname}`, { maxRedirects: 0 });
  check(
    own.status() >= 300 && own.status() < 400,
    `the owner's hash link redirects (${own.status()})`,
  );
  const nothing = await ctx.request.get(`/read/0000000000000000`, { maxRedirects: 0 });
  check(nothing.status() === 404, `a hash of nothing is 404 (${nothing.status()})`);
  const other = await newSilentContext(browser, { baseURL: BASE });
  const anon = await other.request.get(`${u.pathname}`, { maxRedirects: 0 });
  check(anon.status() === 404, `signed out: 404 (${anon.status()})`);
  await signUp(other, `other-${scheme}`);
  const theirs = await other.request.get(`${u.pathname}`, { maxRedirects: 0 });
  check(theirs.status() === 404, `another account: 404 (${theirs.status()})`);
  const api = await other.request.get(`/api/read/${id}`);
  check(
    api.status() === 404,
    `another account cannot open the material id either (${api.status()})`,
  );
  await other.close();

  check(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
  await ctx.close();
}

const innerHeightOf = (page) => page.viewportSize()?.height ?? 800;

async function phone(scheme) {
  const tag = `iphone-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 13"],
    baseURL: BASE,
    colorScheme: scheme,
  });
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  await signUp(ctx, tag);
  const { page, errs } = await open(ctx);
  const cdp = await ctx.newCDPSession(page);
  const w = await aWord(page);
  check(!!w, "a word is on screen");
  if (!w) return ctx.close();

  await taps(cdp, w.x, w.y, 1);
  await page.waitForTimeout(200);
  let c = await card(page);
  check(c?.kind === "word", `a tap selects the word (${c?.kind})`);
  await page.screenshot({ path: join(OUT, `select-word-${tag}.png`) });

  await page.waitForTimeout(700);
  await taps(cdp, w.x, w.y, 3);
  await page.waitForTimeout(200);
  c = await card(page);
  check(c?.kind === "para", `three quick taps select the paragraph (${c?.kind})`);
  check(c?.domSel === "", "no native selection");
  await page.screenshot({ path: join(OUT, `select-para-${tag}.png`) });

  await page.waitForTimeout(700);
  await taps(cdp, w.x, w.y, 5);
  await page.waitForTimeout(250);
  c = await card(page);
  check(c?.kind === "book", `five quick taps select the book (${c?.kind})`);
  await page.screenshot({ path: join(OUT, `select-book-${tag}.png`) });

  // Back closes it.
  await page.goBack();
  await page.waitForTimeout(300);
  check((await card(page)) === null, "back closes the card");

  // A sideways swipe grades, never selects.
  const item = await page.evaluate(
    ({ y }) => {
      const el = [...document.querySelectorAll("[data-testid=reader-book] [data-item]")].find(
        (e) => {
          const r = e.getBoundingClientRect();
          return r.top <= y && r.bottom >= y;
        },
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id: el.dataset.item, x: r.left + r.width / 2, y };
    },
    { y: w.y },
  );
  if (item) {
    await drag(cdp, item.x - 30, item.y, item.x + 32, item.y, 24, 30);
    await page.waitForTimeout(900);
    const graded = await page.evaluate(
      (id) => document.querySelector(`[data-item="${id}"] .lk-rail`)?.dataset.grade ?? null,
      item.id,
    );
    check(graded !== null, `the swipe graded the item (${graded})`);
    check((await card(page)) === null, "a swipe selects nothing");
  }
  check(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
  await ctx.close();
}

await desktop("light");
await desktop("dark");
await phone("light");
await phone("dark");
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall selection checks passed");
process.exit(failed ? 1 : 0);
