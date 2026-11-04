// /read side-by-side word review QA (docs/books-plan.md, "Side-by-side word
// review"): silent, desktop and phone, light and dark screenshots.
//
//   QA_BASE=http://localhost:3217 QA_EMAIL=<an OWNER_EMAILS address> bun scripts/qa/qa-read-side.mjs [outDir]
//
// QA_EMAIL must be the server's OWNER_EMAILS: reader v2 and the side review
// are the owner's alone while their flags are off. Imports the fixture EPUB,
// opens the review (?side), jumps to a new word, reveals, grades it Again,
// undoes, grades again, and after its learning step finds it again as due.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = process.env.QA_EMAIL || "qa+side@lianki.test";
const OUT = process.argv[2] || "test-results/read-side";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const ctx = await newSilentContext(browser, {
  viewport: { width: 1440, height: 900 },
  baseURL: BASE,
});
await ctx.route("**/api/words/tts*", (r) => r.fulfill({ status: 503, body: "{}" }));
{
  const up = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PW, name: "QA Side" },
    headers: { origin: BASE },
  });
  if (!up.ok()) {
    const r = await ctx.request.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PW },
      headers: { origin: BASE },
    });
    check(r.ok(), `sign-in (${r.status()})`);
  }
}
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto("/read", { waitUntil: "networkidle" });
await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
await page.waitForURL(/\/read\/[^/]+$/, { timeout: 30000 });
const id = page.url().split("/").pop();
await page.goto(`/read/${id}?side`, { waitUntil: "networkidle" });
const card = page.getByTestId("read-side-review");
check(
  await card.isVisible({ timeout: 20000 }).catch(() => false),
  "?side opens the card beside the book",
);
const due = await ctx.request.get(`/api/read/${id}/word-due`);
check(due.ok(), `word-due answers (${due.status()})`);

const focused = () =>
  page.evaluate(() => document.querySelector("[data-side-focus]")?.textContent ?? null);
const term = () => page.locator("[data-side-term]").textContent();
await page.waitForTimeout(1500);
if (!(await focused())) await page.keyboard.press("n");
await page.waitForTimeout(1500);
const w1 = await focused();
check(!!w1, `a word is focused in the text (${w1})`);
const box = await card.boundingBox();
const book = await page.getByTestId("reader-book").boundingBox();
check(
  !!box && !!book && box.x >= book.x + book.width - 1,
  "the card sits beside the book, not over it",
);
await page.getByTestId("side-grade-1").waitFor({ timeout: 15000 });
await page.waitForFunction(
  () => !document.querySelector('[data-testid="side-grade-1"]')?.hasAttribute("disabled"),
  null,
  { timeout: 20000 },
);
check(
  (await page.locator("[data-side-back]").isVisible()) &&
    !(await page.getByTestId("side-reveal").count()),
  "the meaning is shown at once, no reveal step",
);
await page.screenshot({ path: join(OUT, "side-desktop-light.png") });
await page.emulateMedia({ colorScheme: "dark" });
await page.screenshot({ path: join(OUT, "side-desktop-dark.png") });
await page.emulateMedia({ colorScheme: "light" });

const t1 = await term();
await page.keyboard.press("Digit1");
await page.waitForTimeout(1500);
const w2 = await focused();
check(!!w2 && (await term()) !== t1, `a grade moves on to the next word (${w1} → ${w2})`);
await page.keyboard.press("z");
await page.waitForTimeout(1500);
check((await term()) === t1, "Z goes back to the graded word");
await page.waitForFunction(
  () => !document.querySelector('[data-testid="side-grade-1"]')?.hasAttribute("disabled"),
  null,
  { timeout: 20000 },
);
await page.keyboard.press("Digit1");
// Again: due within its learning step (minutes); then D finds it.
const sent = Date.now();
let isDue = false;
while (Date.now() - sent < 200000 && !isDue) {
  await page.waitForTimeout(10000);
  const d = await (await ctx.request.get(`/api/read/${id}/word-due`)).json();
  isDue = (d.due ?? []).length > 0;
}
check(isDue, "the word graded Again comes back as due");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check(!(await card.isVisible().catch(() => false)), "Esc closes the card");
await page.getByTestId("read-side-open").click();
await page.waitForTimeout(2500);
const w3 = await focused();
// A word left from earlier runs on the same account may be due first: any due word.
const dueNow = (await (await ctx.request.get(`/api/read/${id}/word-due`)).json()).due ?? [];
check(!!w3 && dueNow.includes(w3.toLowerCase()), `opening again starts at a due word (${w3})`);

// PC: the selection card's 本段单词 opens the paragraph's words in the panel.
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const second = page.locator('[data-line] [data-t="3"]').first();
await second.click();
await page.locator('[data-action="review-words"]').click({ timeout: 10000 });
const list = page.getByTestId("side-list");
check(
  await list.isVisible({ timeout: 10000 }).catch(() => false),
  "本段单词 shows in the side panel",
);
check(
  !(await page
    .getByTestId("read-word-review")
    .isVisible()
    .catch(() => false)),
  "no overlay over the book on PC",
);
const items = await list.locator("[data-side-item]").count();
await page.waitForTimeout(1500);
const cur = await list.locator('[aria-current="true"]').getAttribute("data-side-item");
check(items > 1 && !!cur, `the list (${items} words) has a focused word (${cur})`);
const pick = list.locator("[data-side-item]").nth(2);
const pw = await pick.getAttribute("data-side-item");
await pick.click();
await page.waitForTimeout(1500);
check(
  (await list.locator('[aria-current="true"]').getAttribute("data-side-item")) === pw,
  `picking a word in the list shows its card (${pw})`,
);
await page.waitForFunction(
  () => !document.querySelector('[data-testid="side-grade-3"]')?.hasAttribute("disabled"),
  null,
  { timeout: 20000 },
);
await page.keyboard.press("Digit3");
await page.waitForTimeout(1500);
const after = await list.locator('[aria-current="true"]').getAttribute("data-side-item");
check(after !== pw, `a grade moves on in the list (${pw} → ${after})`);
await page.screenshot({ path: join(OUT, "side-list-desktop-light.png") });
// A card not due yet (graded Good just now) is never landed on: not by the
// list's next, not by N; a click still opens it.
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await second.click();
await page.locator('[data-action="review-words"]').click({ timeout: 10000 });
await page.waitForTimeout(2500);
const landed = [];
for (let i = 0; i < 6; i++) {
  landed.push(await list.locator('[aria-current="true"]').getAttribute("data-side-item"));
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-grade-3"]')?.hasAttribute("disabled"),
    null,
    { timeout: 20000 },
  );
  await page.keyboard.press("Digit3");
  await page.waitForTimeout(1200);
}
check(!landed.includes(pw), `the list's next skips the word not due yet (${landed.join(", ")})`);
await list.locator(`[data-side-item="${pw}"]`).click();
await page.waitForTimeout(1500);
check(
  (await page.locator("[data-side-status]").textContent())?.trim() !== "" &&
    (await page.locator("[data-side-term]").textContent()) === pw,
  `a click still opens the word not due yet (${pw})`,
);
// A word in none of his decks: its word and meaning (or 制卡), never the load
// error (the cardless answer itself is unit-tested: sideCardOf).
await page
  .locator("[data-line] [data-t]", { hasText: /^Henry$/ })
  .first()
  .click();
await page.waitForTimeout(2500);
check(
  (await page.locator("[data-side-back], [data-testid=side-make]").first().isVisible()) &&
    !(await page
      .getByTestId("side-retry")
      .isVisible()
      .catch(() => false)),
  "a word in none of his decks shows its meaning or 制卡, not an error",
);
await page.screenshot({ path: join(OUT, "side-cardless-desktop-light.png") });

// Phone: the card over the bottom of the book.
const phone = await newSilentContext(browser, { ...devices["iPhone 13"], baseURL: BASE });
await phone.addCookies(await ctx.cookies());
const pp = await phone.newPage();
await pp.goto(`/read/${id}?side`, { waitUntil: "networkidle" });
await pp.getByTestId("read-side-review").waitFor({ timeout: 20000 });
await pp.waitForTimeout(2000);
await pp.screenshot({ path: join(OUT, "side-phone-light.png") });
await pp.emulateMedia({ colorScheme: "dark" });
await pp.screenshot({ path: join(OUT, "side-phone-dark.png") });
check(errs.length === 0, `no page errors (${errs.join(" | ")})`);

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nread side review: all checks passed");
process.exit(failed ? 1 : 0);
