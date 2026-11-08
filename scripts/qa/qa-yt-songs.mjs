// YouTube songs on /read, M1 (docs/youtube-song-examples.md). Silent; iPhone
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
// - flag off, not the owner: /read/youtube and its route answer 404;
// - flag on: a pasted LRC becomes a /read text, the same video again updates it;
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
    const page = await ctx.newPage();
    const res = await page.goto("/read/youtube");
    check(res?.status() === 404, `flag off: /read/youtube is 404 (${res?.status()})`);
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
    await ctx.route(/youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com/, (r) => r.abort());
    await signUp(ctx, scheme);
    // The server caches flags for 30 s (docs/feature-flags.md): wait for the switch to reach it.
    for (let i = 0; i < 25 && (await post(ctx, "")).status() === 404; i++)
      await new Promise((r) => setTimeout(r, 2000));

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

    await page.goto("/read/youtube");
    await page.getByTestId("yt-song-new").waitFor({ timeout: 30000 });
    await page.getByTestId("yt-song-url").fill(VIDEO);
    await page.getByTestId("yt-song-lyrics").fill(LRC);
    const count = await page.getByTestId("yt-song-count").innerText();
    check(/3/.test(count), `the form counts the timed lines (${count.trim()})`);
    await page.screenshot({ path: join(OUT, `new-${scheme}.png`) });

    await page.goto(`/read/${id}`);
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
} finally {
  setFlag(false);
  await browser.close();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
