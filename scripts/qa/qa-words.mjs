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
  check((await rows.count()) >= 20, `the list opens with ${await rows.count()} words`);
  check((await page.locator("span.text-emerald-600").count()) > 0, "new words are shown in green");
  const statusOf = async (i) => (await rows.nth(i).locator("span.tabular-nums").innerText()).trim();
  check((await statusOf(0)) === "new", `an ungraded new word says "new": ${await statusOf(0)}`);

  // F moves the cursor down (like ↓) and the focused row shows its meaning.
  const blurred = (i) =>
    rows
      .nth(i)
      .locator("span.text-sm")
      .first()
      .evaluate((el) => el.className.includes("blur-["));
  await page.keyboard.press("f");
  check(!(await blurred(1)) && (await blurred(0)), "F moves down and reveals the focused row");
  await page.keyboard.press("r");
  check(!(await blurred(0)), "R moves back up");

  const listsNow = async () =>
    (await page.evaluate(async () => (await fetch("/api/words/lists")).json())).lists.find(
      (l) => l.source === first.id,
    );
  const reviewed = () =>
    page.waitForResponse((r) => r.url().includes("/review") && r.request().method() === "POST");

  // Each grade is saved at once — no screens, no Next.
  let res = reviewed();
  await page.keyboard.press("a");
  check((await (await res).status()) === 200, "A saves that one word immediately");
  check(
    /^\d+(\.\d)?(s|m|h|d|mo|y)$/.test(await statusOf(0)),
    `it shows when it returns: ${await statusOf(0)}`,
  );

  // Going back and grading again re-grades: still one card, one review.
  await page.keyboard.press("r");
  res = reviewed();
  await page.keyboard.press("d");
  await res;
  let l = await listsNow();
  check(l?.cards === 1, `re-grading keeps one card (${l?.cards})`);

  // Z undoes it: the word is new again.
  await page.keyboard.press("r");
  const undone = page.waitForResponse((r) => r.url().includes("/undo"));
  await page.keyboard.press("z");
  check((await (await undone).status()) === 200, "Z undoes the focused word on the server");
  l = await listsNow();
  check(
    l?.cards === 0 && (await statusOf(0)) === "new",
    `after undo the word is new again (${l?.cards} cards)`,
  );

  // The URL keeps the list; a refresh lands back in it.
  check(/[?&]list=/.test(page.url()), `the open list is in the URL: ${new URL(page.url()).search}`);
  await page.reload({ waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) > 0, "a refresh lands back in the list");

  // Endless: grade 60 words in a row; more keep coming and all are saved.
  // 40 ms apart: still far faster than a person, slow enough for loading to keep up.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("w");
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1500);
  l = await listsNow();
  const ahead = await rows.evaluateAll(
    (els) => els.filter((e) => e.querySelector("span.tabular-nums")?.textContent === "new").length,
  );
  check(
    l?.cards === 60 && ahead > 0,
    `60 graded and saved (${l?.cards}), more words below (${ahead})`,
  );

  // Scrolling to the bottom (no cursor movement, as on a phone) loads more too.
  const listBox = page.locator('[role="list"]');
  const heightBefore = await listBox.evaluate((el) => el.scrollHeight);
  for (let i = 0; i < 4; i++) {
    await listBox.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(700);
  }
  const heightAfter = await listBox.evaluate((el) => el.scrollHeight);
  check(
    heightAfter > heightBefore,
    `scrolling to the end loads more words (${heightBefore} → ${heightAfter}px)`,
  );

  // Phone: holding a row reveals it (listen mode); letting go hides it again.
  {
    const { devices } = await import("playwright");
    const phone = await browser.newContext({
      ...devices["iPhone 13"],
      storageState: await ctx.storageState(),
    });
    const m = await phone.newPage();
    await m.goto(page.url(), { waitUntil: "networkidle" });
    const mrows = m.locator('[role="listitem"]');
    await mrows.first().waitFor({ timeout: 15000 });
    const blurredM = () =>
      mrows
        .nth(0)
        .locator("span.text-sm")
        .first()
        .evaluate((el) => el.className.includes("blur-["));
    const box = await mrows.nth(0).boundingBox();
    await m.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await m.mouse.down();
    await m.waitForTimeout(500);
    const whileHeld = !(await blurredM());
    await m.mouse.up();
    await m.waitForTimeout(100);
    check(whileHeld && (await blurredM()), "phone: holding a row reveals it, releasing hides it");
    await phone.close();
  }

  // /alphabet: same drill over its own catalog; its lists stay off /words.
  await page.goto(`${BASE}/alphabet`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "ja", exact: true }).click();
  await page.getByRole("button", { name: "add", exact: true }).first().click();
  await rows.first().waitFor({ timeout: 15000 });
  const firstTerms = await rows.locator("span.truncate.font-medium").allInnerTexts();
  const fronts = firstTerms.map((t) => t.split("\n")[0].trim());
  check(fronts[0] === "あ", `alphabet starts with あ: ${fronts.slice(0, 3)}`);
  // A reverse card is kept well away from its forward card (a right under あ gives it away).
  check(!fronts.slice(0, 20).includes("a"), "あ and its reverse a are kept 20+ rows apart");
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
  await page.keyboard.press("w");
  check((await sent).status() === 200, "study all: a graded word saves");

  // Drag the second list above the first by its handle; the order is saved.
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const handles = page.getByRole("button", { name: "Drag to reorder" });
  const before = (
    await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
  )
    .filter((l) => l.lang === first.lang)
    .map((l) => l.id);
  const h2 = await handles.nth(1).boundingBox();
  const h1 = await handles.nth(0).boundingBox();
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(h1.x + h1.width / 2, h1.y - 10, { steps: 8 });
  await page.mouse.up();
  let after = before;
  for (let i = 0; i < 10 && after.join() === before.join(); i++, await page.waitForTimeout(300))
    after = (
      await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
    )
      .filter((l) => l.lang === first.lang)
      .map((l) => l.id);
  check(after[0] === before[1] && after[1] === before[0], "dragging a handle reorders the lists");

  // Drag the second row right: it nests under the first (Anki-style subdeck).
  await page.waitForTimeout(500);
  const n2 = await handles.nth(1).boundingBox();
  await page.mouse.move(n2.x + n2.width / 2, n2.y + n2.height / 2);
  await page.mouse.down();
  await page.mouse.move(n2.x + n2.width / 2 + 40, n2.y + n2.height / 2, { steps: 8 });
  await page.mouse.up();
  let nested = null;
  for (let i = 0; i < 10 && !nested?.parentId; i++, await page.waitForTimeout(300))
    nested = (
      await page.evaluate(async () => (await (await fetch("/api/words/lists")).json()).lists)
    ).find((l) => l.id === after[1]);
  check(nested?.parentId === after[0], "dragging right nests a list under the one above");

  // A group: study it (its lists) and study all, with groups present.
  const group = await page.evaluate(
    async () =>
      (
        await (
          await fetch("/api/words/lists", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "QA group", lang: "mul", source: "group:words" }),
          })
        ).json()
      ).list.id,
  );
  await page.evaluate(
    async ([g, ids]) =>
      fetch("/api/words/lists", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order: [{ id: g, parentId: null }, ...ids.map((id) => ({ id, parentId: g }))],
        }),
      }),
    [group, after],
  );
  await page.goto(`${BASE}/words?list=${group}`, { waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) > 0, "studying a group lists its words");
  await page.goto(`${BASE}/words?list=all`, { waitUntil: "networkidle" });
  await rows.first().waitFor({ timeout: 15000 });
  check((await rows.count()) > 0, "study all works with groups present");
  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  check(false, `threw: ${e.message}`);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
