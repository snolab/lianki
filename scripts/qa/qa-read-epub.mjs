// /read EPUB import QA: silent, iPhone size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3017 node scripts/qa/qa-read-epub.mjs [outDir]
//
// Signs up a throwaway dev account (needs DEV_EMAIL_PASSWORD_AUTH=1), picks the
// public-domain fixture EPUB on /read, and checks: the book opens in the
// reader with its title, author and chapter picker; only one section of lines
// is in the DOM; next-chapter moves; the position survives a reload; a
// DRM-protected EPUB is refused with the message; another account cannot read
// the book; the book is deletable. Words (lib/read/words.ts): the reader's
// header shows the scan summary (counts adding up to the distinct words, the
// unrecognised list on tap) and the coverage ring; the list row shows the
// word count and the ring.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

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
await page.waitForURL(/\/read\/[^/]+$/, { timeout: 30000 });
const id = page.url().split("/").pop();
await page.getByRole("heading", { name: "The Gift of the Magi" }).waitFor({ timeout: 15000 });
check(await page.getByText("O. Henry", { exact: true }).isVisible(), "author shown");
const chapters = page.locator('[data-testid="read-chapters"] select option');
check(
  (await chapters.count()) === 3,
  `chapter picker lists 3 chapters (${await chapters.count()})`,
);
const rendered = await page.locator('[id^="line-"]').count();
check(rendered > 0 && rendered <= 200, `one section rendered (${rendered} lines in the DOM)`);

// The scan summary of the imported book's words.
{
  const scan = page.locator('[data-testid="read-scan"]');
  await scan.waitFor({ timeout: 15000 });
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
  await page.locator('[data-testid="read-scan-mastered"]').waitFor({ timeout: 30000 });
  const num = async (t) =>
    Number((await page.locator(`[data-testid="read-scan-${t}"]`).innerText()).replace(/\D/g, ""));
  const names = await page.locator('[data-testid="read-scan-names"]').count();
  const namesN = names
    ? Number((await page.locator('[data-testid="read-scan-names"]').innerText()).replace(/\D/g, ""))
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
  const ring = page.locator('[data-testid="read-scan"] [data-testid="read-ring"]');
  const cov = Number(await ring.getAttribute("data-coverage"));
  check(cov > 0 && cov < 20, `coverage ring: names only, no cards yet (${cov}%)`);
  await page.locator('[data-testid="read-scan-toggle"]').click();
  const unrec = page.locator('[data-testid="read-scan-unrecognised"] li');
  check((await unrec.count()) === parts[3], `unrecognised words listed (${await unrec.count()})`);
  await page.screenshot({ path: join(OUT, "read-scan-light.png"), fullPage: true });
  await page.locator('[data-testid="read-scan-toggle"]').click();
}

await page.getByRole("button", { name: "Next chapter" }).click();
await page.waitForTimeout(300);
const sel = await page.locator('[data-testid="read-chapters"] select').inputValue();
check(sel === "1", `next chapter selects chapter 2 (value ${sel})`);
await page.screenshot({ path: join(OUT, "read-book-light.png") });
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("heading", { name: "The Gift of the Magi" }).waitFor();
check(
  (await page.locator('[data-testid="read-chapters"] select').inputValue()) === "1",
  "reading position survives a reload",
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
  await p.getByRole("heading", { name: "The Gift of the Magi" }).waitFor();
  await p.locator('[data-testid="read-scan-mastered"]').waitFor({ timeout: 30000 });
  await p.screenshot({ path: join(OUT, "read-book-dark.png") });
  await p.goto("/read", { waitUntil: "networkidle" });
  await p.screenshot({ path: join(OUT, "read-list-dark.png") });
  await dark.close();
}

// The list row: word count and ring.
{
  await page.goto("/read", { waitUntil: "networkidle" });
  const row = page.locator('[data-testid="read-row-words"]').first();
  await row.waitFor({ timeout: 15000 });
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
  await alert.waitFor({ timeout: 15000 });
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
