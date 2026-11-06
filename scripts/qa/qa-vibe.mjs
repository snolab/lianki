// /vibe QA (docs/vibe.md): silent, iPhone size, light and dark screenshots. No
// real microphone and no real speech anywhere: Chromium's fake media device
// (silent.mjs) stands in for the mic, the VAD's script is a stub this test drives,
// and a small WebSocket server here stands in for the owner's Mac, answering
// invented text. Nothing plays and nothing is recorded.
//
//   QA_BASE=http://localhost:3417 QA_EMAIL=<an owner in the local site_role> \
//     QA_PASSWORD=… bun scripts/qa/qa-vibe.mjs [outDir]
//
// Against qa:all's wrangler dev (--keep). Flips read.vibe in the LOCAL D1 itself
// (`wrangler d1 execute --local`), and turns it back off at the end.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/vibe";
const PW = process.env.QA_PASSWORD || "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const sql = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`local d1: ${r.stderr}`);
};
const setFlag = (on) =>
  sql(
    on
      ? "INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('read.vibe', 1, datetime('now'), 'qa')"
      : "DELETE FROM feature_flags WHERE key = 'read.vibe'",
  );

// The stand-in for the Mac: says ready, and answers each utterance with the next invented line.
const LINES = [
  "Bonjour, je m'appelle Léa et je viens de Lyon.",
  "你好，很高兴认识你，你学中文多久了？",
  "下一张",
];
let finals = 0;
const macOpen = new Set();
const mac = Bun.serve({
  port: 0,
  fetch(req, s) {
    return s.upgrade(req) ? undefined : new Response("no", { status: 400 });
  },
  websocket: {
    open(ws) {
      macOpen.add(ws);
      ws.send(JSON.stringify({ t: "ready", engine: "qa", model: "qa" }));
    },
    close(ws) {
      macOpen.delete(ws);
    },
    message(ws, m) {
      if (typeof m !== "string") return;
      const d = JSON.parse(m);
      if (d.t !== "end") return;
      ws.send(
        JSON.stringify({
          t: "final",
          id: d.id,
          text: LINES[finals++ % LINES.length],
          lang: "en",
          model: "qa",
          ms: 1,
          audioMs: 1000,
          signals: { decoder: "ctc" },
        }),
      );
    },
  },
});

// The VAD's script: real getUserMedia still runs (on the fake device); this hands control to the test.
const VAD_STUB = `window.vad = { MicVAD: { new: async (o) => {
  window.__vadOptions = o;
  return { start: async () => {}, pause: async () => {}, destroy: async () => { window.__vadDestroyed = (window.__vadDestroyed||0)+1; } };
} } };`;

const speak = (page) =>
  page.evaluate(async () => {
    const o = window.__vadOptions;
    o.onSpeechStart();
    for (let i = 0; i < 3; i++)
      o.onFrameProcessed({ isSpeech: 0.9 }, new Float32Array(512).fill(0.2));
    await o.onSpeechEnd(new Float32Array(16000).fill(0.2));
  });

// The full Chromium in new headless mode: the headless shell has no media stack.
// The fake capture device keeps the real microphone out of reach.
const browser = await launchSilent(chromium, {
  channel: "chromium",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

async function run(colorScheme, email) {
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 13"],
    colorScheme,
    permissions: ["microphone"],
  });
  await ctx.addInitScript(
    `try { localStorage.setItem("lk:agent-local-stt", "ws://localhost:${mac.port}"); } catch {}`,
  );
  const page = await ctx.newPage();
  await page.route("**/vad-web@*/**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: VAD_STUB }),
  );
  await page.route("**/onnxruntime-web@*/**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: "" }),
  );
  const gum = [];
  await page.exposeFunction("__noteGum", () => void gum.push(Date.now()));
  await ctx.addInitScript(`(() => {
    const m = navigator.mediaDevices; if (!m) return;
    const real = m.getUserMedia.bind(m);
    m.getUserMedia = (c) => { window.__noteGum(); window.__tracks = window.__tracks || [];
      return real(c).then((s) => { window.__tracks.push(...s.getTracks()); return s; }); };
  })();`);
  const lines = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/debug/stt") || r.url().includes("clip"))
      lines.push(`BAD ${r.url()}`);
  });

  const res = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email, password: PW },
  });
  check(res.ok(), `signed in (${colorScheme})`);

  // Flag off: no page, no route, for the owner too.
  setFlag(false);
  await page.waitForTimeout(31_000); // the flag cache
  const off = await page.goto(`${BASE}/vibe`);
  check(off.status() === 404, "flag off: /vibe is 404 for the owner");
  check((await page.goto(`${BASE}/vibe/new`)).status() === 404, "flag off: /vibe/new is 404 too");
  await page.goto(`${BASE}/vibe`);
  const refused = await page.evaluate(
    async () =>
      (
        await fetch("/api/vibe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tap: true, title: "x" }),
        })
      ).status,
  );
  check(refused === 404, "flag off: the server refuses a start");

  setFlag(true);
  await page.waitForTimeout(31_000);
  await page.goto(`${BASE}/vibe`);
  await page.waitForSelector('[data-testid="vibe-list"]');
  const listedBefore = await page.locator('[data-testid="vibe-row"]').count();
  await page.screenshot({ path: join(OUT, `list-before-${colorScheme}.png`) });
  await page.click('[data-testid="vibe-new"]');
  await page.waitForSelector('[data-testid="vibe-start"]');
  check(new URL(page.url()).pathname === "/vibe/new", "New conversation goes to /vibe/new");
  check(gum.length === 0, "the page opens no microphone");
  check(macOpen.size === 0, "the page opens no socket to the Mac");
  check(
    (await page.locator('[role="dialog"], [data-testid="vibe-home"] select').count()) === 0,
    "no form: no dialog, no language picker",
  );
  const body = await page.innerText("body");
  check(!/30 (days|天)|自动删除/.test(body), "no 30-day text, and no deletion promise");
  check(
    (await page.getAttribute('[data-testid="vibe-start"]', "disabled")) === null,
    "Start is ready at once: nothing to dismiss first",
  );
  check(await page.isVisible('[data-testid="vibe-care"]'), "the line to the user is beside Start");
  check(await page.isVisible('[data-testid="vibe-recognised"]'), "the recognised-languages line");
  const vw = page.viewportSize();
  const startBox = await page.locator('[data-testid="vibe-start"]').boundingBox();
  check(
    startBox.y >= 0 && startBox.y + startBox.height <= vw.height,
    "Start is on screen without scrolling",
  );
  check(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= vw.width,
    "no sideways scroll at phone width",
  );
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, `start-${colorScheme}.png`) });

  // A start without the tap's field opens nothing on the server.
  const noTap = await page.evaluate(
    async () =>
      (
        await fetch("/api/vibe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "x" }),
        })
      ).status,
  );
  check(noTap === 400, "the server refuses a start without the tap");

  // Off by default on /preferences, and leaving the field saves nothing.
  const puts = [];
  const notePut = (r) => {
    if (r.method() === "PUT" && r.url().includes("/api/vibe/settings")) puts.push(r.postData());
  };
  page.on("request", notePut);
  const fieldReady = () =>
    page.waitForFunction(() => {
      const f = document.querySelector('[data-testid="vibe-retention"]');
      return f && !f.disabled;
    });
  await page.goto(`${BASE}/preferences`);
  const field = page.locator('[data-testid="vibe-retention"]');
  await fieldReady();
  check((await field.inputValue()) === "", "retention is off by default");
  await field.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, `preferences-${colorScheme}.png`) });
  await field.focus();
  await field.blur();
  await page.waitForTimeout(300);
  check(!puts.length, "tapping in and out of the field saves nothing");
  await field.fill("45");
  await field.blur();
  await page.waitForSelector('[data-testid="vibe-retention-note"]');
  check(puts.length === 1 && puts[0].includes("45"), "a number the user types is saved");
  await page.reload();
  await fieldReady();
  check((await field.inputValue()) === "45", "and reads back");
  await field.fill("");
  await field.blur();
  await page.waitForSelector('[data-testid="vibe-retention-note"]');
  check(puts.length === 2 && puts[1].includes("null"), "clearing it turns it off");
  page.off("request", notePut);
  await page.goto(`${BASE}/vibe/new`);
  await page.waitForSelector('[data-testid="vibe-start"]');
  check(gum.length === 0, "still no microphone");

  // A script's click is not a tap.
  await page.evaluate(() => document.querySelector('[data-testid="vibe-start"]').click());
  await page.waitForTimeout(300);
  check(gum.length === 0, "a scripted click starts nothing");

  page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().startsWith("vibe "))
      console.log("console:", m.text().slice(0, 300));
  });
  await page.click('[data-testid="vibe-start"]');
  await page
    .waitForSelector('[data-testid="vibe-indicator"][data-state="running"]', { timeout: 15_000 })
    .catch(async (e) => {
      console.log("page says:", (await page.innerText("body")).slice(0, 300));
      throw e;
    });
  check(gum.length === 1, "Start opens the (fake) microphone once");
  check(macOpen.size === 1, "and one socket to the Mac");
  check(
    new URL(page.url()).pathname === "/vibe/new",
    "no address of its own before a line is heard",
  );
  await page.screenshot({ path: join(OUT, `running-empty-${colorScheme}.png`) });

  await speak(page);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="vibe-line"]').length === 1,
  );
  await speak(page);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="vibe-line"]').length === 2,
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="vibe-line"][data-lang]:not([data-lang=""])')
        .length === 2,
  );
  await page.waitForFunction(() => /^\/vibe\/[0-9a-f-]{36}$/.test(location.pathname));
  check(true, "with a line heard, the address is the conversation's");
  check(
    (await page.locator('[data-testid="vibe-indicator"][data-state="running"]').count()) === 1,
    "and it goes on running: the address changed without leaving the page",
  );
  const logPath = new URL(page.url()).pathname;
  const langs = await page.$$eval('[data-testid="vibe-line"]', (e) => e.map((x) => x.dataset.lang));
  check(langs.includes("zh"), `each line shows its language (${langs})`);
  await page.screenshot({ path: join(OUT, `running-${colorScheme}.png`) });

  const stuck = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="vibe-indicator"]').getBoundingClientRect();
    window.scrollTo(0, 1e6);
    return r.top;
  });
  check(stuck === 0, "the indicator stays at the top");

  // Spoken "下一张" is text: nothing moved, no chat line.
  await page.click('[data-testid="vibe-pause"]');
  await page.waitForSelector('[data-testid="vibe-indicator"][data-state="paused"]');
  check(
    await page.evaluate(() => window.__tracks.every((t) => t.readyState === "ended")),
    "Pause stops the microphone's tracks",
  );
  await page.waitForTimeout(200);
  check(macOpen.size === 0, "Pause closes the socket to the Mac");
  await page.screenshot({ path: join(OUT, `paused-${colorScheme}.png`) });
  const held = finals;
  await page.waitForTimeout(300);
  check(finals === held, "nothing reaches the Mac while paused");

  await page.click('[data-testid="vibe-resume"]');
  await page.waitForSelector('[data-testid="vibe-indicator"][data-state="running"]');
  check(gum.length === 2, "Resume is a new (fake) microphone");
  await speak(page);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="vibe-line"]').length === 3,
  );

  // Hiding the page pauses it, with its reason on screen.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForSelector('[data-testid="vibe-why"]');
  check(
    await page.isVisible('[data-testid="vibe-indicator"][data-state="paused"]'),
    "a hidden page pauses, visibly",
  );
  await page.evaluate(() => {
    delete document.visibilityState;
  });

  await page.click('[data-testid="vibe-stop"]');
  await page.waitForSelector('[data-testid="vibe-ended"]');

  // Back into it later: the log, by its address, stays readable and can go on.
  await page.goto(`${BASE}${logPath}`);
  await page.waitForSelector('[data-testid="vibe-ended"]');
  check(
    (await page.locator('[data-testid="vibe-line"]').count()) === 3,
    "the log shows what was said, after a reload",
  );
  check(gum.length === 2, "and opens no microphone by itself");
  check(
    (await page.textContent('[data-testid="vibe-langs"]')).length > 0,
    "and shows the conversation's languages",
  );
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, `log-${colorScheme}.png`) });
  const material = (await page.getAttribute('[data-testid="vibe-open"]', "href")).split("/").pop();
  await page.evaluate(() => document.querySelector('[data-testid="vibe-continue"]').click());
  await page.waitForTimeout(300);
  check(gum.length === 2, "a scripted click does not go on");
  await page.click('[data-testid="vibe-continue"]');
  await page.waitForSelector('[data-testid="vibe-indicator"][data-state="running"]');
  check(gum.length === 3, "Keep going opens the (fake) microphone");

  // Another device on the same address follows it (the push service stubbed).
  const follower = await ctx.newPage();
  let push = null;
  await follower.routeWebSocket(/read-stream/, (ws) => {
    push = ws;
  });
  await follower.goto(`${BASE}${logPath}`);
  await follower.waitForSelector('[data-testid="vibe-line"]');
  await follower.waitForFunction(
    () => document.querySelectorAll('[data-testid="vibe-line"]').length === 3,
  );
  await page.bringToFront();
  await speak(page);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="vibe-line"]').length === 4,
  );
  const liveHref = await page.getAttribute('[data-testid="vibe-all"]', "href");
  await page.waitForTimeout(300);
  push?.send(JSON.stringify({ book: material }));
  await follower.waitForFunction(
    () => document.querySelectorAll('[data-testid="vibe-line"]').length === 4,
    { timeout: 10_000 },
  );
  check(liveHref === "/vibe", "a follower on the address sees the new line, live");
  await follower.close();

  await page.click('[data-testid="vibe-stop"]');
  await page.waitForSelector('[data-testid="vibe-ended"]');

  // 新词: reading the list and opening a word store nothing and ask no model.
  const writes = [];
  page.on("request", (r) => {
    if (/batch-grade|make-cards/.test(r.url()) && !(r.postData() ?? "").includes('"probe"'))
      writes.push(r.postData() ?? "");
    if (/\/gloss/.test(r.url()) && !(r.postData() ?? "").includes('"cached":true'))
      writes.push(`uncached gloss ${r.postData()}`);
  });
  await page.click('[data-testid="vibe-tab-words"]');
  await page.waitForSelector('[data-testid="vibe-word"]');
  check(
    (await page.locator('[data-testid="vibe-word"][data-kind="new"]').count()) > 1,
    "the words heard are listed as new",
  );
  check(
    await page.evaluate(() => {
      const el = document.querySelector('.lk-book [data-f="n"]');
      return !!el && getComputedStyle(el).textDecorationStyle === "dotted";
    }),
    "each carries the reader's own mark, drawn",
  );
  await page.screenshot({ path: join(OUT, `words-${colorScheme}.png`) });
  const first = page.locator('[data-testid="vibe-word"][data-kind="new"]').first();
  const heardWord = await first.getAttribute("data-word");
  await first.click();
  await page.waitForSelector('[data-testid="vibe-word-card"]');
  await page.waitForSelector('[data-testid="vibe-word-meaning"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `word-card-${colorScheme}.png`) });
  await page.click('[data-testid="vibe-word-close"]');
  check(!writes.length, `opening and closing a word writes nothing (${writes.join(" | ")})`);

  // The slider's grade makes the card; Undo in the hold sends nothing.
  await first.click();
  const knob = page.locator('[data-testid="vibe-word-card"] [role=slider]');
  const swipe = async () => {
    await page.waitForTimeout(600); // past the press that opened the card (OPENING_MS)
    const k = await knob.boundingBox();
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down();
    await page.mouse.move(k.x + k.width / 2 + 70, k.y + k.height / 2, { steps: 8 });
    await page.mouse.move(k.x + k.width / 2 + 170, k.y + k.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await swipe();
  await page.waitForSelector('[data-testid="vibe-word-added"]');
  await page.click('[data-testid="vibe-word-undo"]');
  await page.waitForTimeout(300);
  check(!writes.length, "Undo in the hold sends nothing");
  await swipe();
  await page.waitForSelector('[data-testid="vibe-word-added"]');
  check(!writes.length, "a swipe is held before it is sent");
  const done = page.waitForResponse(
    (r) => /batch-grade/.test(r.url()) && !(r.request().postData() ?? "").includes('"probe"'),
    { timeout: 12_000 },
  );
  const res2 = await done;
  check(res2.ok(), `after the hold, one batch makes the card (${res2.status()})`);
  check(
    writes.length === 1 && writes[0].includes(JSON.stringify(heardWord)),
    "only that word was sent",
  );
  await page.screenshot({ path: join(OUT, `ended-${colorScheme}.png`) });

  // The doc, in /read: no polish offer, no 30-day text, nothing to share, the private mark.
  const href = await page.getAttribute('[data-testid="vibe-open"]', "href");
  await page.goto(`${BASE}${href}`);
  await page.waitForSelector('[data-testid="vibe-doc-note"]', { timeout: 30_000 });
  check(
    (await page.locator('[data-testid="read-polish-offer"]').count()) === 0,
    "no polish offer when opened from the list",
  );
  check((await page.locator("[data-lk-private-screen]").count()) > 0, "the page is marked private");
  check(
    !/30 (days|天)|自动删除|deleted automatically/.test(
      await page.textContent('[data-testid="vibe-doc-note"]'),
    ),
    "the note promises no deletion",
  );
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, `reader-${colorScheme}.png`) });
  await page.goto(`${BASE}${href}?streamingFrom=vibe`);
  await page.waitForSelector('[data-testid="vibe-doc-note"]', { timeout: 30_000 });
  check(
    (await page.locator('[data-testid="read-polish-offer"]').count()) === 0,
    "no polish offer while following it live",
  );
  const asked = [];
  page.on("request", (r) => {
    if (/\/api\/read\/.*\/(translate|gloss|polish)/.test(r.url())) asked.push(r.url());
  });
  await page.waitForTimeout(3_000);
  check(!asked.length, "following it live sends no line to a model by itself");

  // The list: its row, a rename, an old link, and a start that heard nothing.
  await page.goto(`${BASE}/vibe`);
  await page.waitForSelector('[data-testid="vibe-row"]');
  check(
    (await page.locator('[data-testid="vibe-row"]').count()) === listedBefore + 1,
    "the conversation is on the list",
  );
  const meta = await page.locator('[data-testid="vibe-row"]').first().innerText();
  check(/\b20\d\d\b/.test(meta) && /Lines: 4/.test(meta), `its row has date and length (${meta})`);
  check(/French|Chinese/.test(meta), "and its languages");
  check(!/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(meta), "no ambiguous date");
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, `list-${colorScheme}.png`) });
  const row = page.locator('[data-testid="vibe-row"]').first();
  await row.locator('[data-testid="read-row-menu"]').click();
  await page.screenshot({ path: join(OUT, `list-menu-${colorScheme}.png`) });
  await page.click('[data-testid="read-row-rename"]');
  await page.fill('[data-testid="read-row-title-input"]', "An invented coffee");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="vibe-row-title"]')
      ?.textContent?.includes("An invented coffee"),
  );
  await page.reload();
  await page.waitForSelector('[data-testid="vibe-row"]');
  check(
    (await page.locator('[data-testid="vibe-row-title"]').first().textContent()) ===
      "An invented coffee",
    "a rename stays",
  );
  await page.goto(`${BASE}/vibe?doc=${logPath.split("/").pop()}`);
  check(new URL(page.url()).pathname === logPath, "an old /vibe link with a doc goes to its log");
  await page.goto(`${BASE}/vibe/new`);
  await page.click('[data-testid="vibe-start"]');
  await page.waitForSelector('[data-testid="vibe-indicator"][data-state="running"]');
  await page.click('[data-testid="vibe-stop"]');
  await page.waitForSelector('[data-testid="vibe-ended"]');
  check(
    new URL(page.url()).pathname === "/vibe/new",
    "a stop that heard nothing stays on /vibe/new",
  );
  await page.goto(`${BASE}/vibe`);
  await page.waitForSelector('[data-testid="vibe-list"]');
  check(
    (await page.locator('[data-testid="vibe-row"]').count()) === listedBefore + 1,
    "and leaves no entry",
  );

  // A fresh, non-owner account gets none of it.
  const stranger = await newSilentContext(browser, { ...devices["iPhone 13"] });
  const email2 = `qa+vibe-${Date.now()}@lianki.test`;
  const su = await stranger.request.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email: email2, password: "qa-test-pass-1234", name: "QA" },
  });
  check(su.ok(), "a second account signs up");
  const id = href.split("/").pop();
  check(
    (await stranger.request.get(`${BASE}/api/read/${id}`)).status() === 404,
    "it cannot read the transcript",
  );
  const p2 = await stranger.newPage();
  check((await p2.goto(`${BASE}/vibe`)).status() === 404, "/vibe is 404 for it with the flag on");
  check((await p2.goto(`${BASE}/vibe/new`)).status() === 404, "/vibe/new too");
  check((await p2.goto(`${BASE}${logPath}`)).status() === 404, "and the log's address");
  await stranger.close();

  // The list's ⋯ menu deletes it, asking once.
  await page.goto(`${BASE}/vibe`);
  await page.waitForSelector('[data-testid="vibe-row"]');
  let asked2 = 0;
  page.once("dialog", (d) => {
    asked2++;
    void d.accept();
  });
  const before = await page.locator('[data-testid="vibe-row"]').count();
  await page
    .locator('[data-testid="vibe-row"]')
    .first()
    .locator('[data-testid="read-row-menu"]')
    .click();
  await page.click('[data-testid="read-row-delete"]');
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="vibe-row"]').length === n,
    before - 1,
  );
  check(asked2 === 1, "the owner deletes it from the list, asked once");
  check((await page.request.get(`${BASE}/api/read/${id}`)).status() === 404, "and it is gone");
  check((await page.goto(`${BASE}${logPath}`)).status() === 404, "from its address too");

  check(!lines.length, `no cloud STT or clip request (${lines.join(", ")})`);
  await ctx.close();
}

try {
  const email = process.env.QA_EMAIL;
  if (!email) throw new Error("QA_EMAIL: an owner in the local site_role");
  await run("light", email);
  await run("dark", email);
} finally {
  setFlag(false);
  await browser.close();
  mac.stop(true);
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
