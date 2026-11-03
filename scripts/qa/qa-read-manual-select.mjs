// /read reader v2: a hand-made selection gets the selection card
// (docs/books-plan.md, "Manual selection"; owner 2026-11-03 22:25 JST).
// Silent; desktop (a mouse drag) and iPhone (an emulated long-press
// selection, then a handle moved), light and dark screenshots.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-read-manual-select.mjs [outDir]
//
// Against a local server on D1 with `read.reader-v2` on in the LOCAL D1 (the
// review and 制卡 need the reader's backend). Throwaway accounts and the
// public-domain fixture EPUB only:
//
// - a selection over two paragraphs, starting and ending inside words, gives
//   one card: the text snapped to whole words, its familiarity, copy, read
//   aloud (exactly the selection), the link, 「复习选中内容的所有单词」, 制卡 (N);
// - the native selection is left as he made it; moving a handle updates the card;
// - the link is /read/<hash>#r=<line>.<token>-<line>.<token>; it opens at the
//   range, highlighted and flashed, with its card; signed out it is 404;
// - a tap elsewhere clears; a click on a word is still the combo's word.
//
// No sound: speechSynthesis is a fake (on top of silent.mjs).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-manual-select";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};
const until = async (page, f, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(80);
  }
  return false;
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
      timers.push(setTimeout(() => u.onend && u.onend(), 120));
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

const browser = await launchSilent(chromium);

async function signUp(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+msel-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Select" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
}

async function open(ctx) {
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
  // The word map (marks on the words): 制卡 counts need it.
  await until(page, () => page.evaluate(() => !!document.querySelector(".lk-book [data-f]")), 8000);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(700);
  return { page, errs, id };
}

/**
 * Two consecutive paragraphs on screen (each with words), and points inside
 * a word of the first and a word of the second: where a selection starts
 * and ends, mid-word, and the words it must snap to.
 */
const twoParas = (page) =>
  page.evaluate(() => {
    const ps = [...document.querySelectorAll("[data-testid=reader-book] p[data-line]")].filter(
      (p) => {
        const r = p.getBoundingClientRect();
        return (
          r.top > 110 && r.bottom < innerHeight * 0.8 && p.querySelectorAll("[data-t]").length > 6
        );
      },
    );
    for (let i = 0; i + 1 < ps.length; i++) {
      const a = ps[i];
      const b = ps[i + 1];
      if (Number(b.dataset.line) === Number(a.dataset.line)) continue;
      const wa = [...a.querySelectorAll("[data-t]")].find((e) => e.textContent.length >= 4);
      const wb = [...b.querySelectorAll("[data-t]")]
        .slice(2)
        .find((e) => e.textContent.length >= 4);
      if (!wa || !wb) continue;
      const ra = wa.getBoundingClientRect();
      const rb = wb.getBoundingClientRect();
      return {
        a: { x: ra.left + ra.width * 0.5, y: ra.top + ra.height / 2 },
        b: { x: rb.left + rb.width * 0.5, y: rb.top + rb.height / 2 },
        first: { line: Number(a.dataset.line), t: Number(wa.dataset.t), text: wa.textContent },
        last: { line: Number(b.dataset.line), t: Number(wb.dataset.t), text: wb.textContent },
      };
    }
    return null;
  });

const card = (page) =>
  page.evaluate(() => {
    const c = document.querySelector("[data-testid=read-select-card]");
    if (!c) return null;
    const hl = globalThis.CSS?.highlights?.get?.("lk-sel");
    return {
      kind: c.dataset.kind,
      text: c.querySelector("[data-testid=read-select-text]")?.textContent ?? null,
      actions: [...c.querySelectorAll("[data-action]")].map((b) => [
        b.dataset.action,
        b.textContent,
      ]),
      fam: !!c.querySelector("[data-testid=read-select-fam]"),
      link: !!c.querySelector("[data-testid=read-select-link] svg path"),
      ranges: hl ? hl.size : document.querySelectorAll(".lk-book [data-sel]").length,
      domSel: getSelection()?.toString() ?? "",
      top: c.getBoundingClientRect().top,
      bottom: c.getBoundingClientRect().bottom,
    };
  });

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

/** Selection checks shared by desktop and phone, once a range card is up. */
async function rangeCard(page, ctx, sel, tag) {
  await until(page, async () => (await card(page))?.kind === "range", 3000);
  const c = await card(page);
  check(c?.kind === "range", `the selection gets the card (${c?.kind})`);
  if (c?.kind !== "range") return null;
  const text = norm(c.text);
  check(
    text.startsWith(sel.first.text) && text.endsWith(sel.last.text),
    `snapped to whole words: "${text.slice(0, 24)}…${text.slice(-24)}" (${sel.first.text} … ${sel.last.text})`,
  );
  check(/\n/.test(c.text ?? ""), "the preview spans the two paragraphs");
  check(c.domSel.length > 0, "his native selection is left as it is");
  check(c.ranges > 0, "the range is highlighted");
  check(!!c.link, "the link button (inline SVG)");
  const acts = c.actions.map((a) => a[0]);
  for (const a of ["read-aloud", "copy-text", "review-words"])
    check(acts.includes(a), `action ${a} (${acts})`);
  const review = c.actions.find((a) => a[0] === "review-words")?.[1] ?? "";
  check(/selection/i.test(review), `the review says it is the selection's (${review})`);
  await until(page, async () => (await card(page))?.fam, 4000);
  check((await card(page))?.fam, "its familiarity summary");
  await page.screenshot({ path: join(OUT, `range-${tag}.png`) });

  // Read aloud: exactly the selection.
  await page.evaluate(() => window.__spoken.splice(0));
  await page.locator('[data-testid=read-select-card] [data-action="read-aloud"]').click();
  await page.waitForTimeout(400 + text.length * 4);
  const spoken = await page.evaluate(() => window.__spoken.splice(0));
  check(
    norm(spoken.join(" ")) === text,
    `read aloud says the selection (${JSON.stringify(spoken).slice(0, 80)})`,
  );
  check((await card(page))?.kind === "range", "the card stays after a tap on it");

  // The link: #r=<line>.<token>-<line>.<token>.
  await page.getByTestId("read-select-link").click();
  await page.waitForTimeout(200);
  const status = await page
    .getByTestId("read-select-status")
    .textContent()
    .catch(() => "");
  const link = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  const want = `#r=${sel.first.line}.${sel.first.t}-${sel.last.line}.${sel.last.t}`;
  check(
    new RegExp(`/read/[0-9a-f]{16}${want.replace(/\./g, "\\.")}$`).test(link),
    `the link names the range (${link}; want ${want}; ${status})`,
  );

  // 制卡 (N) for the selection's words without cards.
  const make = (await card(page))?.actions.find((a) => a[0] === "make-cards");
  const n = Number(make?.[1]?.match(/\d+/)?.[0] ?? 0);
  check(n > 0, `制卡 counts the selection's new words (${make?.[1]})`);
  if (n > 0) {
    const req = page.waitForResponse((r) => r.url().includes("/make-cards"));
    await page.locator("[data-action=make-cards]").click();
    const made = await (await req).json();
    check(made.terms?.length === n, `制卡 made ${made.terms?.length} (card said ${n})`);
  }

  // The review: /words' rows for the selection's words.
  await page.locator('[data-testid=read-select-card] [data-action="review-words"]').click();
  await page.getByTestId("read-word-review").waitFor({ timeout: 8000 });
  const rows = page.locator("[data-testid=read-word-review] [role=list] [data-i]");
  check(
    await until(page, async () => (await rows.count()) > 0),
    `the review lists the words (${await rows.count()})`,
  );
  const title = await page.getByTestId("read-word-review").textContent();
  check(/selection/i.test(title ?? ""), "the review is titled for the selection");
  await page.screenshot({ path: join(OUT, `review-${tag}.png`) });
  await page.getByTestId("read-review-close").click();
  await page.waitForTimeout(300);
  return link;
}

async function deepLink(ctx, link, tag) {
  const u = new URL(link);
  const page = await ctx.newPage();
  await page.goto(`${u.pathname}?reader=v2${u.hash}`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  const ok = await until(page, async () => (await card(page))?.kind === "range", 8000);
  check(ok, "the range link opens its card");
  const m = /#r=(\d+)\.(\d+)-(\d+)\.(\d+)/.exec(u.hash);
  const on = await page.evaluate(
    ([l0, t0]) => {
      const el = document.querySelector(`[data-line="${l0}"] [data-t="${t0}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, flash: !!document.querySelector("[data-flash]") };
    },
    [m?.[1], m?.[2]],
  );
  check(
    !!on && on.top < (page.viewportSize()?.height ?? 800) && on.bottom > 0,
    "its first word is on screen",
  );
  check(!!on?.flash, "the range flashes");
  check(((await card(page))?.ranges ?? 0) > 0, "and is highlighted");
  await page.screenshot({ path: join(OUT, `deeplink-${tag}.png`) });
  await page.close();
  const other = await newSilentContext(browser, { baseURL: BASE });
  const anon = await other.request.get(u.pathname, { maxRedirects: 0 });
  check(anon.status() === 404, `signed out, the same link is 404 (${anon.status()})`);
  await other.close();
}

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
  await signUp(ctx, tag);
  const { page, errs } = await open(ctx);
  const sel = await twoParas(page);
  check(!!sel, "two paragraphs on screen");
  if (!sel) return ctx.close();

  // A mouse drag from inside one word to inside a word of the next paragraph.
  await page.mouse.move(sel.a.x, sel.a.y);
  await page.mouse.down();
  await page.mouse.move((sel.a.x + sel.b.x) / 2, (sel.a.y + sel.b.y) / 2, { steps: 6 });
  await page.mouse.move(sel.b.x, sel.b.y, { steps: 6 });
  await page.mouse.up();
  const link = await rangeCard(page, ctx, sel, tag);

  // (The review took the card and his selection.) Again, then a click in the book clears it (not a word card), then a click is the combo's word again.
  await page.mouse.move(sel.a.x, sel.a.y);
  await page.mouse.down();
  await page.mouse.move(sel.b.x, sel.b.y, { steps: 8 });
  await page.mouse.up();
  check(
    await until(page, async () => (await card(page))?.kind === "range", 3000),
    "a drag again: its card",
  );
  await page.mouse.click(sel.a.x, sel.a.y);
  await page.waitForTimeout(500);
  check((await card(page)) === null, "a click elsewhere clears the selection's card");
  await page.waitForTimeout(400);
  await page.mouse.click(sel.a.x, sel.a.y);
  await page.waitForTimeout(250);
  check((await card(page))?.kind === "word", "a click on a word still selects the word");
  await page.keyboard.press("Escape");

  if (link) await deepLink(ctx, link, tag);
  check(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
  await ctx.close();
}

async function phone(scheme) {
  const tag = `iphone-${scheme}`;
  console.log(`— ${tag}`);
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 13"],
    baseURL: BASE,
    colorScheme: scheme,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  await signUp(ctx, tag);
  const { page, errs } = await open(ctx);
  const sel = await twoParas(page);
  check(!!sel, "two paragraphs on screen");
  if (!sel) return ctx.close();

  // A long-press selection, emulated: the platform sets the selection (no
  // click), first over one word's middle, then a handle drags its end on.
  const setSel = (end) =>
    page.evaluate(
      ([a, b]) => {
        const p0 = document.caretRangeFromPoint(a.x, a.y);
        const p1 = document.caretRangeFromPoint(b.x, b.y);
        getSelection().setBaseAndExtent(
          p0.startContainer,
          p0.startOffset,
          p1.startContainer,
          p1.startOffset,
        );
      },
      [sel.a, end],
    );
  await setSel({ x: sel.a.x + 2, y: sel.a.y });
  await page.waitForTimeout(80);
  check((await card(page)) === null, "no card while the selection is still moving");
  await setSel(sel.b);
  const link = await rangeCard(page, ctx, sel, tag);
  // (The review took the card and his selection.) Select again.
  await setSel(sel.b);
  check(
    await until(page, async () => (await card(page))?.kind === "range", 3000),
    "selected again: its card",
  );
  const c = await card(page);
  // The card keeps clear of the selection (the side with more room).
  const box = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  check(
    !!c && (c.bottom <= box.top + 1 || c.top >= box.bottom - 1),
    `the card sits on the free side (card ${Math.round(c?.top)}–${Math.round(c?.bottom)}, selection ${Math.round(box.top)}–${Math.round(box.bottom)})`,
  );

  // A tap elsewhere (outside the book) clears it.
  const cdp = await ctx.newCDPSession(page);
  await page.evaluate(() => getSelection().removeAllRanges());
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 4, y: 300 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(600);
  check((await card(page)) === null, "a tap elsewhere clears it");
  // Taps on a word are still the combo's.
  await page.waitForTimeout(400);
  await page.touchscreen.tap(sel.a.x, sel.a.y);
  await page.waitForTimeout(300);
  check((await card(page))?.kind === "word", "a tap on a word still selects the word");

  if (link) await deepLink(ctx, link, tag);
  check(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
  await ctx.close();
}

await desktop("light");
await desktop("dark");
await phone("light");
await phone("dark");
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall manual selection checks passed");
process.exit(failed ? 1 : 0);
