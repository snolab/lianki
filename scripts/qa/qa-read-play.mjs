// /read read-aloud QA: silent, iPhone size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3017 node scripts/qa/qa-read-play.mjs [outDir]
//
// Owner bug (2026-11-03): after importing a book, Play scrolled the page down
// without end. This signs up a throwaway account, imports the public-domain
// fixture EPUB and checks the player (lib/read/player.ts):
//
// - Play reads the current line once and then waits for the reader: no
//   runaway, the page itself never scrolls;
// - Next reads the next line; auto-advance reads on line after line, each
//   once, into the next chapter, and stops at the end;
// - a manual scroll of the list during playback is not fought;
// - the chat mic is held while a line plays (page-audio `always`);
// - a voice failure stops playback with a visible message.
//
// No sound: speechSynthesis is replaced by a fake that only records what it
// was asked to say (on top of silent.mjs), and the server voice is stubbed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-play";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

/** A speechSynthesis that never makes a sound: each line "plays" for LINE_MS. */
const FAKE_SPEECH = `(() => {
  const LINE_MS = 250;
  const spoken = (window.__spoken = []);
  let timers = [];
  const fake = {
    speaking: false,
    getVoices: () => [{ lang: "en-US", name: "QA voice", voiceURI: "qa", default: true, localService: true }],
    speak(u) {
      spoken.push(u.text);
      if (window.__speechDead) return;
      timers.push(setTimeout(() => u.onstart && u.onstart(), 10));
      timers.push(setTimeout(() => u.onend && u.onend(), window.__lineMs || LINE_MS));
    },
    cancel() { timers.forEach(clearTimeout); timers = []; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: fake });
  // The real utterance accepts only real voices; the fake voices need a fake one.
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.voice = null;
      this.rate = 1;
      this.onstart = this.onend = this.onerror = null;
    }
  };
})();`;

const browser = await launchSilent(chromium);
const iphone = devices["iPhone 13"];
const ctx = await newSilentContext(browser, { ...iphone, baseURL: BASE });
await ctx.addInitScript(FAKE_SPEECH);
// The server voice is never asked in the happy path; when it is, it fails.
await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
{
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+play${Date.now()}@lianki.test`, password: PW, name: "QA Play" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up (${r.status()})`);
}
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => {
  errs.push(e.message);
  console.log("pageerror:", e.message);
});

await page.goto("/read", { waitUntil: "networkidle" });
await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
await page.waitForURL(/\/read\/[^/]+$/, { timeout: 30000 });
const id = page.url().split("/").pop();
await page.getByRole("heading", { name: "The Gift of the Magi" }).waitFor({ timeout: 15000 });
const book = await (await ctx.request.get(`/api/read/${id}`)).json();
const lines = book.lines;
const chapters = book.book?.chapters ?? JSON.parse(book.content).chapters;

const status = () =>
  page
    .locator('[data-testid="read-status"]')
    .getAttribute("data-status", { timeout: 500 })
    .catch(() => "idle");
const current = () =>
  page
    .locator('[aria-current="true"][id^="line-"]')
    .getAttribute("id")
    .then((s) => Number(s.slice(5)));
const spoken = () => page.evaluate(() => window.__spoken.slice());
// A line is spoken in sentences: what was said, joined, against whole lines.
const norm = (s) => s.replace(/\s+/g, " ").trim();
const saidText = async () => norm((await spoken()).join(" "));
const linesText = (from, to) => norm(lines.slice(from, to).join(" "));
const until = async (f, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(50);
  }
  return false;
};
const openAt = async (line) => {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`lk:read-pos:${id}`, String(line)]);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "The Gift of the Magi" }).waitFor();
  await page.evaluate(() => (window.__spoken.length = 0));
};

// 1. Wait mode (default): one line, then it waits. The page does not scroll.
// Two past the chapter start: the chapter's title and byline are headings.
await openAt(chapters[1].start + 2);
const start = await current();
const y0 = await page.evaluate(() => scrollY);
await page.getByTestId("read-play").click();
const held = await until(
  () => page.evaluate(() => globalThis.__lkPageAudio?.always?.() === true),
  1000,
);
check(held, "the chat mic is held while the line plays (always, whatever the AEC)");
check(
  await until(async () => (await status()) === "waiting"),
  "after the line: waiting for the reader",
);
await page.waitForTimeout(1500);
check((await saidText()) === linesText(start, start + 1), "only the current line was read, once");
check((await current()) === start, "the current line did not move on by itself");
check((await page.evaluate(() => scrollY)) === y0, "the page itself did not scroll");
await page.screenshot({ path: join(OUT, "read-waiting-light.png") });

await page.getByTestId("read-next").click();
check(
  await until(async () => (await saidText()) === linesText(start, start + 2)),
  "Next reads the next line",
);
check((await current()) === start + 1, "Next moved to the next line");
await until(async () => (await status()) === "waiting");

// A tapped line is read too.
await page.locator(`#line-${start + 3}`).click();
check(
  await until(async () => (await saidText()).endsWith(linesText(start + 3, start + 4))),
  "a tapped line is read",
);
await until(async () => (await status()) === "waiting");
await page.getByRole("button", { name: "Pause" }).click();
check((await status()) === "idle", "Pause in the waiting state stops");

// 2. Auto-advance: reads on, each line once, into the next chapter.
await page.getByTestId("read-auto").check();
const boundary = chapters[2].start;
await openAt(boundary - 2);
check(await page.getByTestId("read-auto").isChecked(), "auto-advance is remembered on this device");
const yA = await page.evaluate(() => scrollY);
await page.getByTestId("read-play").click();
check(
  await until(async () => (await current()) >= boundary + 1, 8000),
  "auto-advance crosses into the next chapter",
);
await page.waitForTimeout(100);
const said = await saidText();
check(
  said.length > 0 && linesText(boundary - 2, boundary + 4).startsWith(said),
  "each line read once, in order",
);
check(
  (await page.locator('[data-testid="read-chapters"] select').inputValue()) === "2",
  "the chapter picker follows",
);
check((await page.evaluate(() => scrollY)) === yA, "the page itself did not scroll");

// 3. A manual scroll during playback is not fought.
const list = page.getByTestId("read-lines");
await list.scrollIntoViewIfNeeded();
// Slower lines, so his flick and the checks after it fit inside a few lines.
await page.evaluate(() => (window.__lineMs = 1500));
// A finger flick on the list (real touch events, as on his phone), once the
// page has settled and the point is really on the list.
const cdp = await ctx.newCDPSession(page);
for (let tries = 0; tries < 5; tries++) {
  await page.waitForTimeout(400);
  const box = await list.boundingBox();
  const x = Math.round(box.x + box.width / 2);
  // The visible part of the list: the page may end before it does, and the
  // bottom navigation floats over the screen's lower edge.
  const bottom = await page.evaluate(
    () =>
      document.querySelector('nav[aria-label="App navigation"]')?.getBoundingClientRect().top ??
      innerHeight,
  );
  const y = Math.round(Math.min(box.y + box.height / 2, (box.y + bottom) / 2));
  const onList = await page.evaluate(
    ([px, py]) => !!document.elementFromPoint(px, py)?.closest('[data-testid="read-lines"]'),
    [x, y],
  );
  if (!onList) continue;
  await cdp.send("Input.synthesizeScrollGesture", {
    x,
    y,
    yDistance: -250,
    gestureSourceType: "touch",
    speed: 1200,
  });
  if (await page.getByTestId("read-follow").isVisible()) break;
}
// Let the flick's momentum settle before taking where he left it.
let top = -1;
for (let k = 0; k < 20; k++) {
  await page.waitForTimeout(250);
  const now = await list.evaluate((el) => el.scrollTop);
  if (now === top) break;
  top = now;
}
const lineAtScroll = await current();
await until(async () => (await current()) >= lineAtScroll + 2, 15000);
await page.evaluate(() => (window.__lineMs = 0));
check(
  Math.abs((await list.evaluate((el) => el.scrollTop)) - top) < 2,
  "after his scroll, the list stays where he put it",
);
check(await page.getByTestId("read-follow").isVisible(), "a Back to the current line button shows");
// Slow lines again: the check below must not race the next line's own scroll.
await page.evaluate(() => (window.__lineMs = 4000));
await page.getByTestId("read-follow").click();
await page.waitForTimeout(1500);
const cur = await current();
const inView = await page.evaluate((i) => {
  const l = document.querySelector('[data-testid="read-lines"]').getBoundingClientRect();
  const r = document.getElementById(`line-${i}`).getBoundingClientRect();
  // Its start is in view (a long paragraph can be taller than the list).
  return r.top >= l.top - 1 && r.top < l.bottom - 20;
}, cur);
check(inView, "Back to the current line scrolls it into view");
await page.evaluate(() => (window.__lineMs = 0));
await page.getByTestId("read-play").click(); // Pause
await page.waitForTimeout(400);
const n = (await spoken()).length;
await page.waitForTimeout(800);
check((await spoken()).length === n && (await status()) === "idle", "Pause stops reading");

// 4. The end: auto-advance stops at the last line.
await openAt(lines.length - 2);
await page.getByTestId("read-play").click();
check(await until(async () => (await status()) === "ended"), "it stops at the end");
check((await current()) === lines.length - 1, "on the last line");

// 5. A failing voice stops with a message instead of racing ahead.
await page.getByTestId("read-auto").uncheck();
await openAt(chapters[1].start + 2);
await page.evaluate(() => (window.__speechDead = true));
await page.getByTestId("read-play").click();
check(
  await until(async () => (await status()) === "error", 8000),
  "a voice failure stops playback",
);
const alert = page.locator('[data-testid="read-status"][role="alert"]');
check(await alert.isVisible(), `the failure is shown: ${(await alert.innerText()).slice(0, 90)}`);
check((await current()) === chapters[1].start + 2, "it did not skip ahead");
await page.evaluate(() => (window.__speechDead = false));

// Dark screenshot, waiting state.
{
  const dark = await newSilentContext(browser, {
    ...iphone,
    baseURL: BASE,
    colorScheme: "dark",
    storageState: await ctx.storageState(),
  });
  await dark.addInitScript(FAKE_SPEECH);
  const p = await dark.newPage();
  await p.goto(`/read/${id}`, { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "The Gift of the Magi" }).waitFor();
  await p.getByTestId("read-play").click();
  await p.locator('[data-testid="read-status"][data-status="waiting"]').waitFor();
  await p.screenshot({ path: join(OUT, "read-waiting-dark.png") });
  await dark.close();
}

await ctx.request.delete(`/api/read/${id}`, { headers: { origin: BASE } });
check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
await browser.close();
console.log(
  failed ? `\n${failed} check(s) failed` : `\n✓ read-play QA passed (screenshots in ${OUT})`,
);
process.exit(failed ? 1 : 0);
