// The reader's offer to tidy a raw transcript (lib/read/polish-offer.ts). Silent;
// iPhone size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-read-polish-offer.mjs [outDir]
//
// Against a local `wrangler dev`: it turns the flags read.gdoc-stream and
// read.live-polish on in the local D1, and off again at the end. Not in qa:all,
// where those flags stay off.
//
// Signs up a throwaway account and stores a made-up transcript under a fake doc
// id through the live-stream route, so the detector's verdict is real. Checks:
//
// - offered on a plain open; never on a page following a stream: socket
//   connecting, live, or lost with no end;
// - "No thanks" stays gone after a reload, reaches another device through the
//   account, and leaves other texts alone;
// - "Don't ask again" and the /preferences switch turn it off and on;
// - the contents sheet's action is there with the offer off and during a stream;
//   it asks the real route and reports its failure (no AI locally), and on a
//   stubbed success reloads into the tidied text, where the action has gone.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-polish-offer";
const PW = "qa-test-pass-1234";
const FLAGS = ["read.gdoc-stream", "read.live-polish"];
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
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`local D1: ${r.stderr}`);
};
const setFlags = (on) =>
  d1(
    on
      ? `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ${FLAGS.map(
          (f) => `('${f}', 1, '2026-11-06T00:00:00.000Z', 'qa')`,
        ).join(", ")}`
      : `DELETE FROM feature_flags WHERE key IN (${FLAGS.map((f) => `'${f}'`).join(", ")})`,
  );

// Made up: one long run of lowercase words with no sentence ends, as speech comes out.
const SPEECH =
  "so um the thing we were looking at last week is that the numbers kind of moved and uh nobody really knows why yet but the plan is to wait and see what happens next and then you know talk about it again when everyone is back ";
const docHtml = (title) =>
  `<html><head><title>${title}</title></head><body>${Array.from(
    { length: 3 },
    () => `<p>${SPEECH.repeat(30)}</p>`,
  ).join("")}</body></html>`;

const fakeDocId = (n) => `FAKE-qa-doc-id-0000000000000000${n}`;

async function addDoc(ctx, n) {
  const r = await ctx.request.post("/api/read/gdoc/stream", {
    data: { docId: fakeDocId(n), html: docHtml(`QA transcript ${n}`), title: `QA transcript ${n}` },
    headers: { origin: BASE },
  });
  if (!r.ok()) throw new Error(`storing the transcript: ${r.status()} ${await r.text()}`);
  return (await r.json()).id;
}

const offer = (page) => page.getByTestId("read-polish-offer");

async function open(page, id, query = "") {
  await page.goto(`/read/${id}${query}`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 30000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
}

async function openSheet(page) {
  await page.getByTestId("reader-ring").click();
  await page.getByTestId("read-polish-menu").waitFor({ timeout: 5000 });
}

async function run(device, scheme) {
  const tag = `${scheme}`;
  console.log(`— ${device} ${scheme}`);
  const dev = devices[device];
  const email = `qa+polish${scheme}${Date.now()}@lianki.test`;
  const ctx = await newSilentContext(browser, { ...dev, baseURL: BASE, colorScheme: scheme });
  const signUp = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Polish" },
    headers: { origin: BASE },
  });
  check(signUp.ok(), `sign-up (${signUp.status()})`);
  const a = await addDoc(ctx, 1);
  const b = await addDoc(ctx, 2);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  // A plain open: offered, and only the detector said so.
  await open(page, a);
  check((await offer(page).count()) === 1, "offered on a plain open of a raw transcript");
  await page.screenshot({ path: join(OUT, `offer-${tag}.png`) });

  // While a stream runs: the socket held open, then lost with no end.
  let socket = null;
  await ctx.routeWebSocket(/\/api\/version\/read-stream/, (ws) => {
    socket = ws;
  });
  await open(page, a, "?streamingFrom=google-docs");
  const badge = page.getByTestId("read-stream-badge");
  check((await badge.getAttribute("data-state")) === "live", "the stream reports live");
  check((await offer(page).count()) === 0, "no offer while the stream is live");
  await openSheet(page);
  check(true, "the action is in the contents sheet during a stream");
  await page.screenshot({ path: join(OUT, `sheet-during-stream-${tag}.png`) });
  await page.keyboard.press("Escape");
  await socket?.close();
  await badge.and(page.locator('[data-state="offline"]')).waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  check((await offer(page).count()) === 0, "no offer when the socket goes offline with no end");
  await page.screenshot({ path: join(OUT, `stream-offline-${tag}.png`) });
  await ctx.unrouteAll({ behavior: "ignoreErrors" });

  // Opened again without the stream: the session is over.
  await open(page, a);
  check((await offer(page).count()) === 1, "offered once the doc opens with no stream");

  // No thanks: stays gone after a reload, for this text only.
  await page.getByTestId("read-polish-skip").click();
  check((await offer(page).count()) === 0, "No thanks hides it");
  await page.reload({ waitUntil: "load" });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  check((await offer(page).count()) === 0, "still gone after a reload");
  await page.screenshot({ path: join(OUT, `gone-after-reload-${tag}.png`) });
  await openSheet(page);
  await page.screenshot({ path: join(OUT, `sheet-${tag}.png`) });
  await page.keyboard.press("Escape");
  await open(page, b);
  check((await offer(page).count()) === 1, "another text still asks");

  // The account has it: a second device, its local storage empty.
  await page.waitForTimeout(1500); // the outbox's 1 s after the last change
  const other = await newSilentContext(browser, { ...dev, baseURL: BASE, colorScheme: scheme });
  await other.addCookies(await ctx.cookies());
  const otherPage = await other.newPage();
  await open(otherPage, a);
  await otherPage.waitForTimeout(1500);
  check((await offer(otherPage).count()) === 0, "No thanks reaches another device");
  await open(otherPage, b);
  check((await offer(otherPage).count()) === 1, "and leaves the other text alone there");
  await other.close();

  // Don't ask again: off for every text; /preferences has the switch.
  await page.getByTestId("read-polish-never").click();
  check((await offer(page).count()) === 0, "Don't ask again hides it");
  await page.reload({ waitUntil: "load" });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  check((await offer(page).count()) === 0, "off after a reload");

  await page.goto("/preferences", { waitUntil: "load" });
  const sw = page.getByTestId("pref-polish-offer");
  await sw.waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  check(!(await sw.isChecked()), "the /preferences switch shows off");
  await sw.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, `preferences-${tag}.png`) });
  await sw.check();
  await open(page, b);
  check((await offer(page).count()) === 1, "the switch turns it back on");
  await page.goto("/preferences", { waitUntil: "load" });
  await sw.waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await sw.uncheck();

  // The action, with the offer off: the real route first (no AI on a local Worker).
  await open(page, b);
  check((await offer(page).count()) === 0, "off again from /preferences");
  await openSheet(page);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/read/${b}/polish`) && r.request().method() === "POST",
      { timeout: 120000 },
    ),
    page.getByTestId("read-polish-menu").click(),
  ]);
  if (res.ok()) {
    check(true, `the action ran on the real route (${res.status()})`);
  } else {
    check(true, `the action asked the real route (${res.status()}, no AI here)`);
    await page
      .getByTestId("read-polish-action")
      .getByText(/failed|unchanged/i)
      .waitFor({ timeout: 5000 });
    check(true, "and says it failed, text unchanged");
    await page.screenshot({ path: join(OUT, `action-failed-${tag}.png`) });

    // Success stubbed: only the AI's answer is missing here.
    let tidied = false;
    await page.route(`**/api/read/${b}/polish`, (r) => {
      tidied = true;
      return r.fulfill({ json: { chunks: 1, kept: 1, lineCount: 1 } });
    });
    await page.route(`**/api/read/${b}`, async (r) => {
      if (!tidied) return r.fallback();
      const resp = await r.fetch();
      const body = await resp.json();
      body.book.polished = { at: "2026-11-06T00:00:00.000Z", chunks: 1, kept: 1 };
      return r.fulfill({ response: resp, json: body });
    });
    await page.getByTestId("read-polish-menu").click();
    await page.waitForEvent("load", { timeout: 15000 });
    await page.locator("[data-testid=reader-book] [data-item]").first().waitFor({ timeout: 30000 });
    check(tidied, "with success stubbed the action posts and the reader reloads");
    await page.getByTestId("reader-ring").click();
    await page.getByTestId("read-raw-transcript").waitFor({ timeout: 5000 });
    check(
      (await page.getByTestId("read-polish-menu").count()) === 0,
      "a tidied text has no action",
    );
    await page.screenshot({ path: join(OUT, `tidied-sheet-${tag}.png`) });
  }

  // 整理's second choice: the speech draft over the book, with a stubbed model.
  const d = await addDoc(ctx, `${scheme}9`);
  await page.route(`**/api/read/${d}/polish-live`, async (r) => {
    const { passages } = r.request().postDataJSON();
    const answer = passages.map((p, i) =>
      i === 0 && passages.length > 1
        ? null
        : { text: `Draft: ${p.slice(0, 60)}.`, thin: i % 2 === 1 },
    );
    return r.fulfill({ json: { passages: answer } });
  });
  await open(page, d);
  await openSheet(page);
  await page.getByTestId("read-draft-open").waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(OUT, `tidy-entry-${tag}.png`) });
  const keptY = await page.evaluate(() => window.scrollY);
  await page.getByTestId("read-draft-open").click();
  await page.getByTestId("read-draft").waitFor({ timeout: 5000 });
  await page.getByTestId("read-draft-flag").first().waitFor({ timeout: 15000 });
  check(
    (await page.getByTestId("read-draft-count").textContent()).includes("/"),
    "the draft says how far it has got",
  );
  await page.screenshot({ path: join(OUT, `speech-draft-${tag}.png`) });
  await page.getByTestId("read-live-tail").locator("[data-tail-w]").first().click();
  await page.getByTestId("read-live-card").waitFor({ timeout: 5000 });
  check(true, "a word of the draft opens its card");
  await page.screenshot({ path: join(OUT, `speech-draft-word-${tag}.png`) });
  await page
    .getByRole("button", { name: /×|clear/i })
    .first()
    .click()
    .catch(() => {});
  await page.getByTestId("read-draft-close").click();
  check(
    (await page.getByTestId("read-draft").count()) === 0 &&
      (await page.evaluate(() => window.scrollY)) === keptY,
    "closing it leaves the original where it was",
  );

  check(errs.length === 0, `no page errors (${errs.join("; ").slice(0, 200)})`);
  await ctx.close();
}

setFlags(true);
// The flags reach the Worker within its 30 s cache.
await new Promise((r) => setTimeout(r, 31_000));
const browser = await launchSilent(chromium);
try {
  for (const scheme of ["light", "dark"]) await run("iPhone 13", scheme);
} finally {
  await browser.close();
  setFlags(false);
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
