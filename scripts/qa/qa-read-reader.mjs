// /read reader QA:
// silent, iPhone and Android sizes, light and dark screenshots.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-read-reader.mjs [outDir]
//
// Signs up a throwaway account, imports the public-domain fixture EPUB (and a
// long book made of it, for the performance numbers; never anyone's own
// book) and checks the reader (app/(app)/read/[id]/ReaderV2.tsx):
//
// - the window scrolls the book (no inner scroller), rows are virtualised,
//   paragraphs carry data-line / data-s / data-t;
// - a sideways swipe grades an item, the next item takes its place on
//   screen, Undo takes it back; a vertical drag never grades;
// - word marks switch by an attribute on <html>, without a re-render;
// - read-aloud reads one item, highlights its sentences, then waits for the
//   swipe; the swipe reads on; follow never moves the chrome;
// - his own scroll reduces the top strip and the island stays a capsule;
// - perf: frame times while flinging a long book under CPU throttling.
//
// No sound: speechSynthesis is a fake that records what it was asked to say
// (on top of silent.mjs), and the server voice is stubbed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-reader";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
const THROTTLE = Number(process.env.QA_CPU_THROTTLE || 4);
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
      timers.push(setTimeout(() => u.onend && u.onend(), window.__lineMs || 200));
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

/** A finger drag with real touch events (pointer events follow), in `steps`. */
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

const browser = await launchSilent(chromium);

async function signUp(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+reader-${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Reader" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
}

/** The reader's first item on screen (below the strip), with its rect. */
const firstItem = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector("[data-reader-strip] > div")?.getBoundingClientRect();
    const minTop = (strip?.bottom ?? 0) + 4;
    const els = [...document.querySelectorAll("[data-testid=reader-book] [data-item]")];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top >= minTop && r.top < innerHeight * 0.6 && r.height > 30)
        return {
          block: Number(el.dataset.block),
          id: el.dataset.item,
          top: r.top,
          x: r.left + r.width / 2,
          y: r.top + Math.min(r.height / 2, 40),
        };
    }
    return null;
  });

async function run(deviceName, scheme, swipe = "js") {
  const dev = devices[deviceName];
  const ctx = await newSilentContext(browser, { ...dev, baseURL: BASE, colorScheme: scheme });
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
  await signUp(ctx, `${deviceName.replace(/\W/g, "")}-${scheme}`);
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
  const tag = `${deviceName.replace(/\W/g, "-")}-${scheme}-${swipe}`;
  console.log(`— ${tag}`);
  await page.screenshot({ path: join(OUT, `reader-top-${tag}.png`) });

  // 1. The window scrolls the book; rows carry their addresses.
  const shape = await page.evaluate(() => {
    const book = document.querySelector("[data-testid=reader-book]");
    const inner = [...document.querySelectorAll("[data-testid=reader-v2] *")].some((el) => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
    });
    return {
      docTall: document.scrollingElement.scrollHeight > innerHeight * 1.5,
      inner,
      rows: book.querySelectorAll("[data-index]").length,
      para: !!book.querySelector("p[data-line] span[data-s] span[data-t]"),
      boxes: [...book.querySelectorAll("p")].some(
        (p) => parseFloat(getComputedStyle(p).borderTopWidth) > 0,
      ),
    };
  });
  check(shape.docTall && !shape.inner, "the window scrolls the book; no inner scroller");
  check(shape.para, "paragraphs carry data-line, sentences data-s, words data-t");
  check(!shape.boxes, "flat: no boxes around paragraphs");

  // 2. Marks: an attribute on <html>, no re-render of the rows.
  const marks0 = await page.evaluate(() => document.documentElement.dataset.readMarks);
  check(marks0 === "all", "word marks default to all");
  const cdp = await ctx.newCDPSession(page);
  // Scroll a little into the book with his own finger: the strip reduces.
  await drag(cdp, 200, 600, 200, 250, 10, 20);
  await page.waitForTimeout(600);
  const reduced = await page.evaluate(
    () => document.querySelector("[data-reader-strip] [data-reduced]") !== null,
  );
  check(reduced, "his own scroll toward content reduces the top strip");
  const capsule = await page.evaluate(() => {
    const nav = document.querySelector("[data-nav-island] nav");
    return nav
      ? getComputedStyle(nav).opacity === "0" || nav.className.includes("opacity-0")
      : true;
  });
  check(capsule, "the bottom island is its capsule while reading");
  await page.screenshot({ path: join(OUT, `reader-reading-${tag}.png`) });

  // 3. A sideways swipe grades the item; the next takes its place.
  let it = await firstItem(page);
  if (!it) {
    await drag(cdp, 200, 500, 200, 380, 8, 20);
    await page.waitForTimeout(600);
    it = await firstItem(page);
  }
  check(!!it, "an item is on screen");
  if (it) {
    await drag(cdp, it.x - 30, it.y, it.x + 32, it.y, 24, 30);
    await page.waitForTimeout(900);
    const graded = await page.evaluate(
      (id) => document.querySelector(`[data-item="${id}"] .lk-rail`)?.dataset.grade ?? null,
      it.id,
    );
    // The New swipe coasts like the browser's own scroll: Good or Easy.
    check(
      swipe === "js" ? graded === "3" : graded === "3" || graded === "4",
      `a swipe right grades ${swipe === "js" ? "Good" : "Good or Easy"} (rail ${graded})`,
    );
    const next = await page.evaluate((b) => {
      const el = [...document.querySelectorAll("[data-testid=reader-book] [data-item]")].find(
        (e) => Number(e.dataset.block) > b,
      );
      return el ? el.getBoundingClientRect().top : null;
    }, it.block);
    check(
      next !== null && Math.abs(next - it.top) < 6,
      `the next item took its place (${next?.toFixed(0)} vs ${it.top.toFixed(0)})`,
    );
    const undo = page.getByTestId("reader-undo");
    check(await undo.isVisible(), "Undo shows after a grade");
    await undo.click();
    await page.waitForTimeout(800);
    const after = await page.evaluate(
      (id) => document.querySelector(`[data-item="${id}"] .lk-rail`)?.dataset.grade ?? null,
      it.id,
    );
    check(after === null, "Undo takes the grade back");
    // A vertical drag never grades.
    it = await firstItem(page);
    await drag(cdp, it.x, it.y + 40, it.x + 12, it.y - 120, 10, 16);
    await page.waitForTimeout(600);
    const none = await page.evaluate(
      () => document.querySelectorAll(".lk-rail[data-grade]").length,
    );
    check(none === 0, "a vertical drag never grades");
  }

  // 4. Read-aloud: one item, sentence highlight, then it waits for the swipe.
  it = await firstItem(page);
  const yBefore = await page.evaluate(() => scrollY);
  await page.getByTestId("read-play").click();
  const lit = await until(
    page,
    () => page.evaluate(() => !!document.querySelector("[data-reading]")),
    3000,
  );
  check(lit, "the sentence being read is highlighted");
  const waited = await until(
    page,
    async () => (await page.getByTestId("read-play").getAttribute("data-status")) === "waiting",
    8000,
  );
  check(waited, "after the item: waits for his swipe");
  const saidN = await page.evaluate(() => window.__spoken.length);
  await page.waitForTimeout(800);
  check(
    (await page.evaluate(() => window.__spoken.length)) === saidN,
    "nothing more is read while waiting",
  );
  const reduced2 = await page.evaluate(
    () => document.querySelector("[data-reader-strip] [data-reduced]") !== null,
  );
  check(reduced2 === reduced, "follow never changes the chrome");
  const cur = await firstItem(page);
  if (cur) {
    await drag(cdp, cur.x - 30, cur.y, cur.x + 32, cur.y, 24, 30);
    const readOn = await until(
      page,
      () => page.evaluate((n) => window.__spoken.length > n, saidN),
      3000,
    );
    check(readOn, "his swipe reads the next item");
  }
  await page.getByTestId("read-play").click();
  void yBefore;

  // On D1 with reader v2's server side on: the swipe's grade reaches the
  // server once its Undo window has passed (lib/read/reader-server.ts).
  const meta = await (await ctx.request.get(`/api/read/${id}`)).json();
  if (meta.readerV2) {
    const sent = await until(
      page,
      async () => {
        const h = await (await ctx.request.get(`/api/read/${id}/history?from=0&to=100000`)).json();
        return (h.reviews ?? []).length > 0;
      },
      15000,
    );
    check(sent, "the grade reached the server after the Undo window");
  }

  // 5. Marks switched in the Aa sheet: attribute only.
  await page.getByRole("button", { name: /Text and word marks/ }).click();
  await page.locator('[data-marks-option="off"]').click();
  check(
    (await page.evaluate(() => document.documentElement.dataset.readMarks)) === "off",
    "marks off: html[data-read-marks=off]",
  );
  await page.screenshot({ path: join(OUT, `reader-aa-${tag}.png`) });
  await page.locator('[data-marks-option="all"]').click();
  await page.keyboard.press("Escape");

  check(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
  await ctx.close();
  return id;
}

/** Frame times while flinging a long book, CPU throttled as a mid-range Android. */
async function perf() {
  const ctx = await newSilentContext(browser, { ...devices["Pixel 7"], baseURL: BASE });
  await ctx.addInitScript(FAKE_SPEECH);
  await signUp(ctx, "perf");
  const page = await ctx.newPage();
  await page.goto("/read", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL(/\/read\/[^/?]+$/, { timeout: 30000 });
  const small = await (await ctx.request.get(`/api/read/${page.url().split("/").pop()}`)).json();
  // A long book made of the fixture: about a novel's length.
  const reps = Number(process.env.QA_PERF_REPS || 40);
  const lines = [];
  const chapters = [];
  const headings = [];
  for (let r = 0; r < reps; r++) {
    chapters.push({ title: `Part ${r + 1}`, start: lines.length });
    headings.push(lines.length);
    lines.push(`Part ${r + 1}`);
    for (const l of small.lines) lines.push(l);
  }
  const res = await ctx.request.post("/api/read", {
    data: { book: { title: "Long fixture", lang: "en", lines, chapters, headings } },
    headers: { origin: BASE },
  });
  check(res.ok(), `long book imported (${lines.length} lines, ${res.status()})`);
  const id = (await res.json()).id;
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`/read/${id}`, { waitUntil: "load" });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 30000 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const t0 = Date.now();
  await page.reload({ waitUntil: "load" });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 60000 });
  const openMs = Date.now() - t0;
  // Frame times during flings (rAF deltas).
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const f = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 5000) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  for (let i = 0; i < 8; i++) {
    await drag(cdp, 200, 650, 200, 150, 8, 8);
    await page.waitForTimeout(400);
  }
  const stats = await page.evaluate(() => {
    const f = window.__frames.slice(2).sort((a, b) => a - b);
    const q = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
    return {
      n: f.length,
      p50: q(0.5),
      p95: q(0.95),
      long: f.filter((x) => x > 50).length,
      rows: document.querySelectorAll("[data-testid=reader-book] [data-index]").length,
      nodes: document.querySelectorAll("[data-testid=reader-book] *").length,
    };
  });
  console.log(
    `perf (${THROTTLE}x CPU, ${lines.length} lines): open ${openMs} ms; frames p50 ${stats.p50.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, >50 ms: ${stats.long}/${stats.n}; rows mounted ${stats.rows}, nodes ${stats.nodes}`,
  );
  check(stats.rows < 80, `virtualised: ${stats.rows} rows mounted`);
  await ctx.close();
}

const only = process.env.QA_ONLY;
if (only === "native") await run("Pixel 7", "light", "native");
if (!only || only === "ui") {
  await run("iPhone 13", "light");
  await run("iPhone 13", "dark");
  await run("Pixel 7", "light");
  await run("Pixel 7", "dark");
  // The New swipe (lib/words/native-slip-gesture.ts, shared with /words).
  await run("Pixel 7", "light", "native");
}
if (!only || only === "perf") await perf();
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall reader checks passed");
process.exit(failed ? 1 : 0);
