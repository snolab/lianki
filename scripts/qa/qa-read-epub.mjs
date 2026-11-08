// /read EPUB import QA: silent, iPhone size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3017 bun scripts/qa/qa-read-epub.mjs [outDir]
//
// Signs up a throwaway dev account (needs DEV_EMAIL_PASSWORD_AUTH=1), picks the
// public-domain fixture EPUB on /read, and checks: the book opens in the
// reader with its title, author and its chapters in the contents sheet; a
// DRM-protected EPUB is refused with the message; another account cannot read
// the book; the book is deletable. Words (lib/read/words.ts): the top of the
// reader shows the scan summary (counts adding up to the distinct words, the
// unrecognised list on tap, the coverage ring), folded on a phone and kept
// open after a reload once unfolded; the list row shows the word count and the
// ring. Screenshots of the top at phone and desktop size, light and dark.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/read-epub";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const iphone = devices["iPhone 13"];

async function account(tag) {
  const ctx = await newSilentContext(browser, { ...iphone, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Read" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
  return ctx;
}

const ctx = await account("epub");
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto("/read", { waitUntil: "networkidle" });
const picker = page.locator('[data-testid="read-import-epub"] input[type="file"]');
check(
  (await picker.getAttribute("accept")) === ".epub,application/epub+zip",
  "picker accepts .epub",
);
await page.screenshot({ path: join(OUT, "read-list-light.png") });

await picker.setInputFiles(FIXTURE);
await page.waitForURL(/\/read\/[^/]+$/, { timeout: budget(30000) });
const id = page.url().split("/").pop();
await page.getByTestId("reader-v2").waitFor({ timeout: budget(15000) });
await page.getByTestId("reader-author").waitFor({ timeout: budget(15000) });
check((await page.getByTestId("reader-author").innerText()) === "O. Henry", "author shown");
check(
  (await page.locator("[data-reader-chapter]").innerText()).includes("Gift of the Magi"),
  "the strip names the book",
);
await page
  .locator("[data-testid=reader-book] [data-item]")
  .first()
  .waitFor({ timeout: budget(15000) });
await page.getByTestId("reader-ring").click();
const chapters = page.locator('[data-testid="reader-toc"] li');
await chapters.first().waitFor({ timeout: budget(15000) });
check((await chapters.count()) === 3, `contents list 3 chapters (${await chapters.count()})`);
await page.keyboard.press("Escape");
await chapters.first().waitFor({ state: "detached", timeout: budget(5000) });

// The scan summary of the imported book's words, at the top of the reader.
const TOP = '[data-testid="reader-scan-top"]';
{
  const scan = page.locator(`${TOP} [data-testid="read-scan"]`);
  await scan.waitFor({ timeout: budget(15000) });
  const details = page.locator(`${TOP} [data-testid="read-scan-details"]`);
  check(!(await details.isVisible()), "on a phone the details start folded");
  await page.screenshot({ path: join(OUT, "read-top-folded-phone-light.png") });
  await page.locator(`${TOP} [data-testid="read-scan-fold"]`).click();
  check(await details.isVisible(), "the title unfolds the details");
  // Exact counts follow the runtime's ICU segmenter (the Worker's V8 and
  // bun's JSC differ by a few words), so the check is a range; the numbers
  // are printed. Bun's own are pinned in unit/read-words.test.ts.
  const m = /([\d,]+) words · ([\d,]+) different/.exec(await scan.innerText());
  const tokens = Number(m?.[1].replace(/,/g, ""));
  const distinct = Number(m?.[2].replace(/,/g, ""));
  check(
    tokens > 4800 && tokens < 5000 && distinct > 1250 && distinct < 1300,
    `header word count (${tokens} running, ${distinct} distinct)`,
  );
  await page
    .locator(`${TOP} [data-testid="read-scan-mastered"]`)
    .waitFor({ timeout: budget(30000) });
  const num = async (t) =>
    Number(
      (await page.locator(`${TOP} [data-testid="read-scan-${t}"]`).innerText()).replace(/\D/g, ""),
    );
  const namesEl = page.locator(`${TOP} [data-testid="read-scan-names"]`);
  const namesN = (await namesEl.count())
    ? Number((await namesEl.innerText()).replace(/\D/g, ""))
    : 0;
  const parts = [
    await num("mastered"),
    await num("learning"),
    await num("new"),
    await num("unrecognised"),
  ];
  const sum = parts.reduce((a, b) => a + b, 0) + namesN;
  check(
    sum === distinct,
    `scan buckets add up to the distinct words (${parts.join("+")}+${namesN} = ${sum})`,
  );
  check(parts[2] > 500, `most words are new: in a word list (${parts[2]})`);
  const ring = page.locator(`${TOP} [data-testid="read-ring"]`);
  const cov = Number(await ring.getAttribute("data-coverage"));
  check(cov > 0 && cov < 20, `coverage ring: names only, no cards yet (${cov}%)`);
  await page.screenshot({ path: join(OUT, "read-top-open-phone-light.png") });
  await page.locator(`${TOP} [data-testid="read-scan-toggle"]`).click();
  const unrec = page.locator(`${TOP} [data-testid="read-scan-unrecognised"] li`);
  check((await unrec.count()) === parts[3], `unrecognised words listed (${await unrec.count()})`);
  await page.locator(`${TOP} [data-testid="read-scan-toggle"]`).click();
}

// Unfolded stays unfolded on this device.
await page.reload({ waitUntil: "networkidle" });
await page.locator(`${TOP} [data-testid="read-scan-mastered"]`).waitFor({ timeout: budget(30000) });
check(
  await page.locator(`${TOP} [data-testid="read-scan-details"]`).isVisible(),
  "the details stay open after a reload",
);

// Dark screenshot of the same book.
{
  const dark = await newSilentContext(browser, {
    ...iphone,
    baseURL: BASE,
    colorScheme: "dark",
    storageState: await ctx.storageState(),
  });
  const p = await dark.newPage();
  await p.goto(`/read/${id}`, { waitUntil: "networkidle" });
  await p.getByTestId("reader-v2").waitFor({ timeout: budget(15000) });
  await p.locator(`${TOP} [data-testid="read-scan-mastered"]`).waitFor({ timeout: budget(30000) });
  await p.screenshot({ path: join(OUT, "read-top-open-phone-dark.png") });
  await p.goto("/read", { waitUntil: "networkidle" });
  await p.screenshot({ path: join(OUT, "read-list-dark.png") });
  await dark.close();
}

// Desktop: the details start open (a fresh device), light and dark.
for (const scheme of ["light", "dark"]) {
  const desk = await newSilentContext(browser, {
    viewport: { width: 1280, height: 900 },
    baseURL: BASE,
    colorScheme: scheme,
    storageState: { cookies: (await ctx.storageState()).cookies, origins: [] },
  });
  const p = await desk.newPage();
  await p.goto(`/read/${id}`, { waitUntil: "networkidle" });
  await p.locator(`${TOP} [data-testid="read-scan-mastered"]`).waitFor({ timeout: budget(30000) });
  check(
    await p.locator(`${TOP} [data-testid="read-scan-details"]`).isVisible(),
    `desktop ${scheme}: the details start open`,
  );
  await p.screenshot({ path: join(OUT, `read-top-desktop-${scheme}.png`) });
  await desk.close();
}

// The list row: word count and ring.
{
  await page.goto("/read", { waitUntil: "networkidle" });
  const row = page.locator('[data-testid="read-row-words"]').first();
  await row.waitFor({ timeout: budget(15000) });
  check(/[\d,]+ words · [\d,]+ different/.test(await row.innerText()), "list row word count");
  check((await page.locator('[data-testid="read-ring"]').count()) >= 1, "list row ring");
  await page.screenshot({ path: join(OUT, "read-list-words-light.png") });
}

// DRM: the fixture with an AES-encrypted chapter listed in encryption.xml.
{
  const zip = await JSZip.loadAsync(readFileSync(FIXTURE));
  zip.file(
    "META-INF/encryption.xml",
    `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/5088469616467574847_7256-h-1.htm.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`,
  );
  const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
  await page.goto("/read", { waitUntil: "networkidle" });
  await picker.setInputFiles({ name: "drm.epub", mimeType: "application/epub+zip", buffer });
  const alert = page.locator('[data-testid="read-epub-error"]');
  await alert.waitFor({ timeout: budget(15000) });
  check(/DRM-protected/.test(await alert.innerText()), "DRM EPUB refused with the message");
  await page.screenshot({ path: join(OUT, "read-drm-light.png") });
}

// Private: another account gets a 404 for the book.
{
  const other = await account("other");
  const r = await other.request.get(`/api/read/${id}`);
  check(r.status() === 404, `another account cannot read the book (${r.status()})`);
  await other.close();
}

// Deletable.
{
  const del = await ctx.request.delete(`/api/read/${id}`, { headers: { origin: BASE } });
  check(del.ok(), `delete (${del.status()})`);
  const gone = await ctx.request.get(`/api/read/${id}`);
  check(gone.status() === 404, "deleted book is gone");
}

check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
await browser.close();
console.log(
  failed ? `\n${failed} check(s) failed` : `\n✓ read-epub QA passed (screenshots in ${OUT})`,
);
process.exit(failed ? 1 : 0);
