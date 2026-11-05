// /read reader v2: the phrase layer QA (owner, 2026-11-05 00:47 JST: when a
// phrase and its words both have cards, the text shows two layers of
// underline — the phrase's under each word's). Silent; iPhone and desktop,
// light and dark screenshots; WebKit too when Playwright has it.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-read-phrase-marks.mjs [outDir]
//
// Against a local server on D1 where reader v2 shows: a dev server
// (`?reader=v2`), or qa:all's wrangler dev (--keep) with the read.reader-v2
// flag on in its local D1 (`bunx wrangler d1 execute lianki --local --command
// "INSERT OR REPLACE INTO feature_flags VALUES ('read.reader-v2', 1,
// datetime('now'), 'qa')"`; delete the row after, the other read suites
// expect v1). Signs up throwaway accounts and imports the public-domain
// fixture EPUB. His cards' meanings (GET /api/read/[id]/meanings) are
// answered here with one phrase card made of three words on screen, and
// those words are made learning cards in the word map, so no model is needed:
//
// - the phrase's words sit in one [data-ph] span with its familiarity
//   (data-pf), drawn as a bar under the words (a background, not a
//   text-decoration), the words keeping their own underline above it;
// - the bar follows html[data-read-marks] (learning under "all" only);
// - a second quick click on a word of it selects the phrase (the combo's
//   phrase level) and the card shows the phrase card's meaning;
// - while the phrase is selected both layers keep their colours (pixels).
//
// QA_ENGINES=chromium|webkit picks engines; QA_DEBUG=1 prints the pixels.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, webkit } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-phrase-marks";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
const BACK = "QA phrase meaning";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const NO_SPEECH = `(() => {
  const fake = { speaking: false, getVoices: () => [], speak() {}, cancel() {},
    addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: fake });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
})();`;

const until = async (page, f, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(50);
  }
  return false;
};

/** Three words in a row on screen, one sentence, only spaces between: the phrase's text. */
const threeWords = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector("[data-reader-strip] > div")?.getBoundingClientRect();
    const minTop = (strip?.bottom ?? 0) + 20;
    for (const s of document.querySelectorAll("[data-testid=reader-book] p[data-line] [data-s]")) {
      const ws = [...s.querySelectorAll(":scope > [data-t]")];
      for (let i = 0; i + 2 < ws.length; i++) {
        const run = ws.slice(i, i + 3);
        const r = run[0].getBoundingClientRect();
        if (r.top < minTop || r.bottom > innerHeight * 0.45) continue;
        if (run.some((w) => !/^\p{L}{3,}$/u.test(w.textContent))) continue;
        const ts = run.map((w) => Number(w.dataset.t));
        if (ts[2] - ts[0] !== 2) continue;
        // Only a space between them, so the phrase is the words.
        let ok = true;
        for (let k = 0; k < 2 && ok; k++) {
          let n = run[k].nextSibling;
          ok =
            !!n && n.nodeType === 3 && /^\s+$/.test(n.textContent) && n.nextSibling === run[k + 1];
        }
        if (!ok) continue;
        return {
          term: run.map((w) => w.textContent.toLowerCase()).join(" "),
          line: Number(s.closest("[data-line]").dataset.line),
          t0: ts[0],
        };
      }
    }
    return null;
  });

/** The phrase span and its words, as drawn. */
const phraseState = (page, line, t0) =>
  page.evaluate(
    ([line, t0]) => {
      const ph = document.querySelector(`[data-line="${line}"] [data-ph^="${t0}-"]`);
      if (!ph) return null;
      const cs = getComputedStyle(ph);
      const fs = parseFloat(cs.fontSize);
      const words = [...ph.querySelectorAll("[data-t]")];
      const marked = words.filter((w) => w.dataset.f);
      const pr = ph.getClientRects()[0];
      const wr = words[0].getBoundingClientRect();
      return {
        ph: ph.dataset.ph,
        pf: ph.dataset.pf,
        words: words.length,
        bg: cs.backgroundImage,
        clone: cs.boxDecorationBreak || cs.webkitBoxDecorationBreak,
        deco: ph.style.textDecorationLine || cs.textDecorationLine,
        marked: marked.length,
        wordLines: marked.every((w) =>
          getComputedStyle(w).textDecorationLine.includes("underline"),
        ),
        // The bar sits under the word: its padding reaches well below the word's box.
        below: pr.bottom - wr.bottom > 0.25 * fs,
        // Near the top of the bar (its height is --lk-ph-h, 0.17em): the edge
        // a selection's highlight would reach first.
        bar: { x: wr.left + wr.width / 2, y: pr.bottom - 0.17 * fs + 1.5, bottom: pr.bottom },
        word: { x: wr.left + wr.width / 2, y: wr.top + wr.height / 2, top: wr.top },
        fs,
      };
    },
    [line, t0],
  );

/** The colour at a point of the page, from a screenshot (no PNG library: the page decodes it). */
async function pixel(page, x, y) {
  const buf = await page.screenshot({
    clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 },
  });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, buf.toString("base64"));
}
/** A one-pixel column of the page from `top` to `bottom`, in device pixels. */
async function column(page, x, top, bottom) {
  const y0 = Math.round(top);
  const h = Math.max(1, Math.round(bottom) - y0);
  const buf = await page.screenshot({ clip: { x: Math.round(x), y: y0, width: 1, height: h } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 1, img.height).data;
    const rows = [];
    for (let i = 0; i < img.height; i++) rows.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    return rows;
  }, buf.toString("base64"));
}

/**
 * The two layers in a column from the word's top to below the bar: from the
 * bottom up, the first run of rows that are not the page is the phrase bar,
 * the next (after a gap of page) the word's own underline. Each as the row in
 * the middle of its run (clear of anti-aliased edges).
 */
function layers(rows, paper) {
  const runs = [];
  let end = -1;
  for (let i = rows.length - 1; i >= -1 && runs.length < 2; i--) {
    const ink = i >= 0 && !near(rows[i], paper, 30);
    if (ink && end < 0) end = i;
    if (!ink && end >= 0) {
      runs.push(Math.round((i + 1 + end) / 2));
      end = -1;
    }
  }
  return runs.length === 2 ? { bar: runs[0], word: runs[1] } : null;
}
const near = (a, b, tol = 10) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function signUp(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+phrase-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Phrase" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
}

async function run(engine, device, scheme) {
  const tag = `${engine.name()}-${device}-${scheme}`;
  console.log(`— ${tag}`);
  const browser = await launchSilent(engine);
  const phone = device === "iphone";
  const ctx = await newSilentContext(browser, {
    ...(phone ? devices["iPhone 13"] : devices["Desktop Chrome"]),
    baseURL: BASE,
    colorScheme: scheme,
    // The routes below must see every request (a service worker would answer some itself).
    serviceWorkers: "block",
  });
  await ctx.addInitScript(NO_SPEECH);
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  await ctx.route("**/api/read/*/translate", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"text":"«qa»"}' }),
  );
  let term = null;
  await ctx.route("**/api/read/*/meanings", (r) => {
    if (process.env.QA_DEBUG) console.log("meanings asked, term:", term);
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cards: term ? [{ term, reading: null, back: BACK, listId: null, f: "l1" }] : [],
        forms: [],
        heads: [],
      }),
    });
  });
  // The phrase's own words as learning cards (a solid word line, so its colour can be read).
  await ctx.route("**/api/read/*/words", async (r) => {
    const res = await r.fetch();
    const d = await res.json();
    const mine = new Set(term?.split(" ") ?? []);
    for (const row of d.words ?? []) if (mine.has(row[0])) Object.assign(row, { 2: 0.1, 3: 0 });
    await r.fulfill({ response: res, json: d });
  });
  await signUp(ctx, tag);
  const page = await ctx.newPage();
  const errs = [];
  // (WebKit reports a fetch cut off by a navigation as "access control checks": not ours.)
  page.on("pageerror", (e) => /access control checks/.test(e.message) || errs.push(e.message));
  await page.goto("/read", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL(/\/read\/[^/?]+$/, { timeout: 30000 });
  const url = `/read/${page.url().split("/").pop()}?reader=v2`;
  await page.goto(url, { waitUntil: "load" });
  await page
    .locator("[data-testid=reader-book] [data-item]")
    .first()
    .waitFor({ timeout: 20000 })
    .catch(async (e) => {
      await page.screenshot({ path: join(OUT, `no-book-${tag}.png`) });
      throw e;
    });
  await page.waitForTimeout(800);
  check(
    (await page.locator("[data-testid=reader-book] [data-ph]").count()) === 0,
    "no phrase cards: no phrase spans",
  );
  const pick = await threeWords(page);
  check(!!pick, `three words in a row on screen (${pick?.term})`);
  if (!pick) return browser.close();

  // His phrase card over those words; the page reads his cards again on load.
  term = pick.term;
  await page.goto(url, { waitUntil: "load" });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 20000 });
  check(
    await until(page, () =>
      page.evaluate((l) => !!document.querySelector(`[data-line="${l}"] [data-ph]`), pick.line),
    ),
    "the phrase card's words get a phrase span",
  );
  // The word map comes separately: wait for the words' own marks.
  await until(page, () =>
    page.evaluate(() => !!document.querySelector("[data-testid=reader-book] [data-ph] [data-f]")),
  );
  await page.waitForTimeout(300);
  let st = await phraseState(page, pick.line, pick.t0);
  check(
    st?.ph === `${pick.t0}-${pick.t0 + 2}` && st?.words === 3,
    `the span holds the three words (${st?.ph}, ${st?.words})`,
  );
  check(st?.pf === "l1", `its familiarity is the card's (${st?.pf})`);
  check(/gradient/.test(st?.bg ?? ""), `the phrase layer is drawn (${st?.bg?.slice(0, 40)})`);
  check(!(st?.deco ?? "").includes("underline"), "the phrase layer is no text-decoration");
  check(st?.clone === "clone", `it is cloned across line wraps (${st?.clone})`);
  check(st?.below, "the phrase bar sits below the words");
  check(
    (st?.marked ?? 0) > 0 && st?.wordLines,
    `its words keep their own underline (${st?.marked} marked)`,
  );
  // Scroll the phrase to the middle of the screen, clear of the chrome, for pixels and taps.
  await page.evaluate(
    ([l, t]) =>
      document
        .querySelector(`[data-line="${l}"] [data-t="${t}"]`)
        ?.scrollIntoView({ block: "center" }),
    [pick.line, pick.t0 + 1],
  );
  await page.waitForTimeout(500);
  st = await phraseState(page, pick.line, pick.t0);
  // The page at the bar's height, in the margin.
  const paper = await pixel(page, 2, st.bar.y);
  const col = [st.word.x, st.word.top, st.bar.bottom + 2];
  const before = await column(page, ...col);
  const at = layers(before, paper);
  check(!!at, "the column shows two layers: the word's line, then the phrase bar");
  const bg = at ? before[at.bar] : null;
  check(!!bg && !near(bg, paper, 6), `the bar is visible (${bg} on ${paper})`);
  await page.screenshot({ path: join(OUT, `phrase-${tag}.png`) });

  // Marks follow html[data-read-marks]: learning bars under "all" only.
  for (const [lvl, want] of [
    ["unknown", false],
    ["off", false],
    ["all", true],
  ]) {
    const drawn = await page.evaluate(
      ([l, t0, lvl]) => {
        document.documentElement.dataset.readMarks = lvl;
        const ph = document.querySelector(`[data-line="${l}"] [data-ph^="${t0}-"]`);
        return /gradient/.test(getComputedStyle(ph).backgroundImage);
      },
      [pick.line, pick.t0, lvl],
    );
    check(drawn === want, `marks "${lvl}": a learning phrase bar ${want ? "shows" : "hides"}`);
  }

  // A word of it, then a second quick click: the phrase.
  const w = st.word;
  // Real touches where the engine takes them (Chromium's CDP); WebKit's
  // synthetic taps send no pointer events, so there a quick double click.
  const cdp = phone && engine === chromium ? await ctx.newCDPSession(page) : null;
  if (cdp)
    for (let i = 0; i < 2; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: w.x, y: w.y }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      if (!i) await page.waitForTimeout(60);
    }
  else await page.mouse.click(w.x, w.y, { clickCount: 2, delay: 20 });
  await page.waitForTimeout(400);
  const card = await page.evaluate(() => {
    const c = document.querySelector("[data-testid=read-select-card]");
    return c
      ? {
          kind: c.dataset.kind,
          meaning: c.querySelector("[data-testid=read-select-meaning]")?.textContent ?? "",
        }
      : null;
  });
  check(card?.kind === "phrase", `a second quick click selects the phrase (${card?.kind})`);
  check(
    card?.meaning.includes(BACK),
    `the card shows the phrase card's meaning (${card?.meaning?.slice(0, 40)})`,
  );
  if (at) {
    // The same device rows as before: each layer's colour, selected.
    const after = await column(page, ...col);
    if (process.env.QA_DEBUG)
      before.forEach((r, i) => console.log(i, r.join(","), after[i]?.join(",")));
    check(
      near(after[at.bar], before[at.bar], 12),
      `selected, the bar keeps its colour (${after[at.bar]} vs ${before[at.bar]})`,
    );
    check(
      near(after[at.word], before[at.word], 30),
      `selected, the word line keeps its colour (${after[at.word]} vs ${before[at.word]})`,
    );
  }
  st = await phraseState(page, pick.line, pick.t0);
  check(st?.wordLines, "selected, its words keep their own underline");
  await page.screenshot({ path: join(OUT, `phrase-selected-${tag}.png`) });
  check(errs.length === 0, `no page errors (${errs.slice(0, 2)})`);
  await browser.close();
}

const only = process.env.QA_ENGINES?.split(",");
const engines = [];
if (!only || only.includes("chromium")) engines.push(chromium);
if (!only || only.includes("webkit"))
  try {
    await (await launchSilent(webkit)).close();
    engines.push(webkit);
  } catch {
    console.log("(WebKit not installed: Chromium only)");
  }
for (const e of engines)
  for (const d of ["iphone", "desktop"])
    for (const s of ["light", "dark"]) {
      if (e === webkit && d === "desktop") continue;
      await run(e, d, s);
    }

console.log(failed ? `\n${failed} check(s) failed` : "\nall phrase-mark checks passed");
process.exit(failed ? 1 : 0);
