// YouTube songs on /reader, M1 (docs/youtube-song-examples.md). Silent; iPhone
// size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-yt-songs.mjs [outDir]
//
// In qa:all (suite yt-songs), or against any local server on local D1: it turns
// `read.youtube-songs` on in the local D1 for the middle part and deletes the
// row at the end. Every YouTube host is blocked: no video, no sound, no
// network; the checks are ours (the ▶, the popup, its close rules), not
// YouTube's player.
//
// - flag off, not the owner: /reader/youtube and its route answer 404;
// - flag on: a pasted LRC becomes a /reader text, the same video again updates it;
// - the reader: one ▶ per sung line; a tap opens the popup (a bottom sheet on a
//   phone) without opening the word card; Escape, × and a tap outside close it.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/yt-songs";
const PW = "qa-test-pass-1234";
const FLAG = "read.youtube-songs";
const VIDEO = "https://youtu.be/AAAAAAAAAAA"; // a made-up id: nothing is fetched
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const d1 = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local D1: ${r.stderr}`);
};
const setFlag = (on) =>
  d1(
    on
      ? `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${FLAG}', 1, '2026-11-09T00:00:00.000Z', 'qa')`
      : `DELETE FROM feature_flags WHERE key = '${FLAG}'`,
  );

const LRC = [
  "[ti:QA Song]",
  "[00:01.00]The morning light comes through the window",
  "[00:05.50]And every word I learn stays with me",
  "[00:09.00]♪",
  "[00:12.00]Sing it again until it sticks",
].join("\n");

const post = (ctx, lyrics = LRC) =>
  ctx.request.post("/api/read/youtube", {
    data: { url: VIDEO, lyrics },
    headers: { origin: BASE, "content-type": "application/json" },
  });

/**
 * The flag is written to D1 straight, so the server's flag cache (30 s, one per
 * isolate: lib/flags-store.ts) may still hold the old value. Wait until the
 * page and its route both answer as `on` says, at most one cache window and a
 * bit: never act on one gate while the other lags.
 */
async function waitForGate(ctx, on) {
  const want = (status) => (on ? status !== 404 : status === 404);
  for (let i = 0; i < 20; i++) {
    const route = (await post(ctx, "")).status();
    const page = (await ctx.request.get("/reader/youtube", { maxRedirects: 0 })).status();
    if (want(route) && want(page)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function signUp(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+yt${tag}${Date.now()}@lianki.test`, password: PW, name: "QA YT" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up (${r.status()})`);
}

const browser = await launchSilent(chromium);
try {
  setFlag(false);
  {
    const ctx = await newSilentContext(browser, { baseURL: BASE });
    await signUp(ctx, "off");
    // A run just before this one may have left the flag on in the cache.
    await waitForGate(ctx, false);
    const page = await ctx.newPage();
    const res = await page.goto("/reader/youtube");
    check(res?.status() === 404, `flag off: /reader/youtube is 404 (${res?.status()})`);
    check((await post(ctx)).status() === 404, "flag off: the route is 404");
    await ctx.close();
  }

  setFlag(true);
  for (const scheme of ["light", "dark"]) {
    console.log(`— iPhone 13 ${scheme}`);
    const ctx = await newSilentContext(browser, {
      ...devices["iPhone 13"],
      baseURL: BASE,
      colorScheme: scheme,
    });
    const blocked = /(^|\.)(youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com)$/;
    await ctx.route(
      (url) => blocked.test(url.hostname),
      (r) => r.abort(),
    );
    await signUp(ctx, scheme);
    check(await waitForGate(ctx, true), "flag on: the page and its route both open");

    const bad = await post(ctx, "just words\nno times");
    check(bad.status() === 400, `lyrics with no timings: 400 (${bad.status()})`);
    const made = await post(ctx);
    check(made.ok(), `a song is saved (${made.status()})`);
    const { id, lineCount } = await made.json();
    check(lineCount === 3, `three sung lines; the ♪ only ends one (${lineCount})`);
    const again = await (await post(ctx)).json();
    check(again.id === id && again.updated === true, "the same video again updates that song");

    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));

    await page.goto("/reader/youtube");
    await page.getByTestId("yt-song-new").waitFor({ timeout: 30000 });
    await page.getByTestId("yt-song-url").fill(VIDEO);
    await page.getByTestId("yt-song-lyrics").fill(LRC);
    const count = await page.getByTestId("yt-song-count").innerText();
    check(/3/.test(count), `the form counts the timed lines (${count.trim()})`);
    await page.screenshot({ path: join(OUT, `new-${scheme}.png`) });

    await page.goto(`/reader/${id}`);
    await page.getByTestId("reader-v2").waitFor({ timeout: 30000 });
    await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 30000 });
    const plays = page.locator("[data-yt-clip]");
    check((await plays.count()) === 3, `one ▶ per sung line (${await plays.count()})`);

    // The sheet itself: the wrapper holds only fixed children, so it has no box of its own.
    const popup = page.getByTestId("yt-clip-popup").locator("[role=dialog]");
    const shown = (want) =>
      popup.waitFor({ state: want ? "visible" : "hidden", timeout: 10000 }).then(
        () => true,
        () => false,
      );
    await plays.first().tap();
    check(await shown(true), "a tap on ▶ opens the popup");
    check((await page.locator("[data-select-card]").count()) === 0, "the ▶ tap opens no word card");
    const box = await popup.boundingBox();
    const vp = page.viewportSize();
    check(
      !!box && !!vp && Math.abs(box.y + box.height - vp.height) < 2 && box.width >= vp.width - 1,
      "on a phone it is a full-width sheet at the bottom",
    );
    await page.screenshot({ path: join(OUT, `popup-${scheme}.png`) });
    await page.keyboard.press("Escape");
    check(await shown(false), "Escape closes it");

    await plays.nth(1).tap();
    await shown(true);
    await page.getByTestId("yt-clip-close").tap();
    check(await shown(false), "× closes it");

    await plays.nth(2).tap();
    await shown(true);
    await page.mouse.click(10, 10);
    check(await shown(false), "a tap outside closes it");

    check(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
    await ctx.close();
  }

  // M2 + M3: cards made from the song's lines keep their line's clip, and /words
  // plays it from the example. Desktop: the focused row shows its example.
  {
    console.log("— desktop /words");
    const ctx = await newSilentContext(browser, {
      baseURL: BASE,
      viewport: { width: 1280, height: 800 },
    });
    const blocked = /(^|\.)(youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com)$/;
    await ctx.route(
      (url) => blocked.test(url.hostname),
      (r) => r.abort(),
    );
    await signUp(ctx, "words");
    const { id } = await (await post(ctx)).json();
    const made = await ctx.request.post(`/api/read/${id}/make-cards`, {
      data: {
        words: [
          { w: "morning", ex: "The morning light comes through the window", back: "the early day" },
          { w: "sticks", ex: "Sing it again until it sticks", back: "stays in mind" },
        ],
      },
      headers: { origin: BASE, "content-type": "application/json" },
    });
    const { listId, terms } = await made.json();
    check(made.ok() && terms?.length === 2, `制卡 from the song's lines (${terms?.join(", ")})`);
    const entries = await (await ctx.request.get(`/api/words/lists/${listId}/entries`)).json();
    const list = Array.isArray(entries) ? entries : (entries.entries ?? []);
    const clips = list.map((e) => (e.clip ? JSON.parse(e.clip) : null));
    check(
      clips.some((c) => c?.t0 === 1000 && c?.t1 === 5500) &&
        clips.some((c) => c?.t0 === 12000 && c?.t1 === 20000),
      "each card's entry keeps its own line's clip",
    );

    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`/words?list=${encodeURIComponent(listId)}`);
    const play = page.locator("[data-yt-clip]");
    const shownPlay = await play
      .first()
      .waitFor({ timeout: 30000 })
      .then(
        () => true,
        () => false,
      );
    check(shownPlay, "/words: the focused row's example has a ▶");
    const sheet = page.getByTestId("yt-clip-popup").locator("[role=dialog]");
    if (shownPlay) {
      await play.first().click();
      check(
        await sheet.waitFor({ state: "visible", timeout: 10000 }).then(
          () => true,
          () => false,
        ),
        "/words: the ▶ opens the popup",
      );
      const box = await sheet.boundingBox();
      check(!!box && Math.round(box.width) === 480, "on a desktop it is a card near the row");
      await page.screenshot({ path: join(OUT, "words-popup.png") });
      await page.keyboard.press("Escape");
      check(
        await sheet.waitFor({ state: "hidden", timeout: 10000 }).then(
          () => true,
          () => false,
        ),
        "/words: Escape closes it",
      );
    }
    check(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
    await ctx.close();
  }
} finally {
  setFlag(false);
  await browser.close();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
