// /read EPUB import QA: silent, iPhone size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3017 node scripts/qa/qa-read-epub.mjs [outDir]
//
// Signs up a throwaway dev account (needs DEV_EMAIL_PASSWORD_AUTH=1), picks the
// public-domain fixture EPUB on /read, and checks: the book opens in the
// reader with its title, author and chapter picker; only one section of lines
// is in the DOM; next-chapter moves; the position survives a reload; a
// DRM-protected EPUB is refused with the message; another account cannot read
// the book; the book is deletable.
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
  await p.screenshot({ path: join(OUT, "read-book-dark.png") });
  await dark.close();
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
