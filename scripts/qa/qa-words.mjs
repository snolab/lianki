// Word lists (/words) end to end on the D1 Worker: sign up, add a catalog list,
// grade one screen by exception, and check what the server stored.
import { chromium } from "playwright";
const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = `qa+words${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

const browser = await chromium.launch();
const ctx = await browser.newContext();
// A signed-up user has answered the first-run question; skip its modal.
await ctx.addInitScript(() => localStorage.setItem("lk:first-run", "account"));
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => {
  // Local runs have no Turnstile site key; that warning is not this page's fault.
  if (!e.message.includes("Turnstile")) errs.push("PAGEERROR " + e.message);
});
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

try {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await page.locator("#email").fill(EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForSelector("#password", { timeout: 10000 });
  await page.locator("#password").fill(PW);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForFunction(
    async () => (await (await fetch("/api/auth/get-session")).json())?.user,
    null,
    { timeout: 20000 },
  );
  check(true, "signed in");

  // Only errors on the page under test count; sign-in's local Turnstile stub is noisy.
  errs.length = 0;
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const catalog = await page.evaluate(
    async () => (await (await fetch("/words/index.json")).json()).lists,
  );
  check(catalog?.length > 0, `catalog lists: ${catalog?.length}`);
  const first = catalog.find((c) => c.lang === "fr") ?? catalog[0];
  await page.getByRole("button", { name: first.lang, exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();

  const rows = page.locator('[role="listitem"]');
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) === 20, `first screen shows ${await rows.count()} words`);
  check((await page.locator("span.text-emerald-400").count()) > 0, "new words are shown in green");
  const interval = (await rows.first().locator("span.tabular-nums").innerText()).trim();
  check(interval === "new", `an ungraded new word says "new": ${interval}`);

  // F moves the cursor down (like ↓) and the focused row shows its meaning.
  const blurred = (i) =>
    rows
      .nth(i)
      .locator("span.text-sm")
      .evaluate((el) => el.className.includes("blur-["));
  await page.keyboard.press("f");
  check(!(await blurred(1)) && (await blurred(0)), "F moves down and reveals the focused row");
  await page.keyboard.press("r");
  check(!(await blurred(0)), "R moves back up");

  // Mark the first word Again, then reload: the mark is sent on leaving, and
  // the same screen comes back from the local draft with the mark on it.
  const firstTerm = (await rows.first().locator("span.truncate.font-medium").innerText()).trim();
  await page.keyboard.press("a");
  const graded = (await rows.first().locator("span.tabular-nums").innerText()).trim();
  check(
    /^\d+(\.\d)?(s|m|h|d|mo|y)$/.test(graded),
    `a graded word shows when it returns: ${graded}`,
  );
  const listsNow = async () =>
    (await page.evaluate(async () => (await fetch("/api/words/lists")).json())).lists.find(
      (l) => l.source === first.id,
    );
  check(/[?&]list=/.test(page.url()), `the open list is in the URL: ${new URL(page.url()).search}`);
  await page.reload({ waitUntil: "networkidle" });
  // The beacon is fire-and-forget: give it a moment to land.
  let saved = 0;
  for (let i = 0; i < 10 && saved !== 1; i++, await page.waitForTimeout(300))
    saved = (await listsNow())?.cards;
  check(saved === 1, `leaving the page saved the one marked word (${saved})`);
  // The URL brought us straight back into the list.
  await rows.first().waitFor({ timeout: 15000 });
  const restoredTerm = (await rows.first().locator("span.truncate.font-medium").innerText()).trim();
  const restoredMark = (await rows.first().getAttribute("class")).includes("bg-red-500");
  check(
    restoredTerm === firstTerm && restoredMark,
    `draft restored the screen and its mark: ${restoredTerm} ${restoredMark ? "Again" : "(no mark)"}`,
  );

  // Nothing is graded in bulk: W on Next jumps to the first ungraded word.
  for (let i = 0; i < 20; i++) await page.keyboard.press("f");
  let posted = false;
  page.on(
    "request",
    (r) => r.url().includes("/review") && r.method() === "POST" && (posted = true),
  );
  await page.keyboard.press("w");
  const cursorAt = await rows.evaluateAll((els) =>
    els.findIndex((e) => e.className.includes("outline-white")),
  );
  check(cursorAt === 1 && !posted, `W on Next jumps to the first ungraded word (row ${cursorAt})`);
  // Grade the rest one by one; the cursor lands on Next, and W there submits.
  const reviewed = page.waitForResponse(
    (r) => r.url().includes("/review") && r.request().method() === "POST",
  );
  for (let i = 0; i < 19; i++) await page.keyboard.press("w");
  await page.keyboard.press("w");
  const res = await reviewed;
  check(res.status() === 200, `all graded, W on Next submits: HTTP ${res.status()}`);
  const body = await res.json();
  check(
    body.cards?.length === 19,
    `the flushed word was not graded twice: ${body.cards?.length} sent`,
  );

  const list = await listsNow();
  check(list?.cards === 20, `list stored: ${list?.cards} cards, cursor ${list?.cursor}`);

  // /alphabet: same drill over its own catalog; its lists stay off /words.
  await page.goto(`${BASE}/alphabet`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "ja", exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();
  await rows.first().waitFor({ timeout: 15000 });
  const firstTerms = await rows.locator("span.truncate.font-medium").allInnerTexts();
  const fronts = firstTerms.map((t) => t.split("\n")[0].trim());
  check(fronts[0] === "あ", `alphabet starts with あ: ${fronts.slice(0, 3)}`);
  // A reverse card never shares a screen with its forward card (a under あ).
  check(!fronts.includes("a"), "あ and its reverse a are on different screens");
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  check((await page.getByText("Hiragana").count()) === 0, "alphabet lists stay off /words");

  // Study all: with two lists, one queue mixes both.
  await page.getByRole("button", { name: first.lang, exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();
  await rows.first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "← lists" }).click();
  await page.getByRole("button", { name: /Study all lists together/ }).click();
  await rows.first().waitFor({ timeout: 15000 });
  check(page.url().includes("list=all"), "study all has its own URL");
  const sent = page.waitForResponse(
    (r) => r.url().includes("/review") && r.request().method() === "POST",
  );
  const n = await rows.count();
  for (let i = 0; i < n; i++) await page.keyboard.press("w");
  await page.keyboard.press("Enter");
  check((await sent).status() === 200, "study all: a graded screen submits");
  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  check(false, `threw: ${e.message}`);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
