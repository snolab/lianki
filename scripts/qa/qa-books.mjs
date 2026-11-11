// /library (the catalogue) and /books (My books) QA: silent, iPhone size,
// light and dark screenshots (docs/books-plan.md, "/library and /books").
//
//   QA_BASE=http://localhost:3017 bun scripts/qa/qa-books.mjs [outDir]
//
// Signs up a throwaway dev account (needs DEV_EMAIL_PASSWORD_AUTH=1) and
// checks, with no request to any outside library: /library lists the
// catalogue under its new title, without "public domain" in the heading, and
// its links go to /library/<lang>/<slug>; a book's page opens there;
// /books is the empty shelf for a new
// account (and a sign-in button for a visitor); an old /books/<lang>/<slug>
// link is a 308 to /library/<lang>/<slug>, query kept, never cached, for a
// visitor and for an account that has not added the book.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/books";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);
const iphone = devices["iPhone 13"];

async function account(tag, colorScheme = "light") {
  const ctx = await newSilentContext(browser, { ...iphone, baseURL: BASE, colorScheme });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+${tag}${Date.now()}@lianki.test`, password: PW, name: "QA Books" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
  return ctx;
}

const errs = [];
const watch = (page) => page.on("pageerror", (e) => errs.push(e.message));

// A visitor: /library lists, /books asks to sign in, an old link 308s.
{
  const ctx = await newSilentContext(browser, { ...iphone, baseURL: BASE });
  const page = await ctx.newPage();
  watch(page);
  await page.goto("/library?lang=en", { waitUntil: "networkidle" });
  const h1 = await page.locator("h1").first().innerText();
  check(h1 === "Library", `/library heading is "Library" (${h1})`);
  const cards = page.getByTestId("books-card");
  check((await cards.count()) > 0, `/library lists books (${await cards.count()})`);
  const href = await cards.first().locator("h3 a").getAttribute("href");
  check(
    /^\/library\/[^/]+\/[^/]+$/.test(href ?? ""),
    `a card links to /library/<lang>/<slug> (${href})`,
  );

  await page.goto(href, { waitUntil: "networkidle" });
  check(page.url().includes("/library/"), "the book's page opens at /library/…");
  check((await page.getByTestId("books-card").count()) === 1, "the book's page shows its card");

  // The old link: a 308 to /library, query kept, not cacheable.
  const old = href.replace(/^\/library\//, "/books/");
  const r = await ctx.request.get(`${old}?from=qa`, { maxRedirects: 0 });
  check(r.status() === 308, `visitor: old link ${old} is 308 (${r.status()})`);
  const loc = r.headers()["location"] ?? "";
  check(loc.endsWith(`${href}?from=qa`), `…to ${href}?from=qa (${loc})`);
  check(
    /no-store|private/.test(r.headers()["cache-control"] ?? ""),
    `…not cached (${r.headers()["cache-control"]})`,
  );

  await page.goto("/books?lang=en", { waitUntil: "networkidle" });
  check(
    (await page.getByTestId("my-books-guest").count()) === 1,
    "/books asks a visitor to sign in",
  );
  await ctx.close();
}

// A new account, light and dark: the shelf, the sidebar, the old link.
for (const scheme of ["light", "dark"]) {
  const ctx = await account(`books-${scheme}`, scheme);
  const page = await ctx.newPage();
  watch(page);
  await page.goto("/books?lang=zh", { waitUntil: "networkidle" });
  await page.getByTestId("my-books-empty").waitFor({ timeout: budget(15000) });
  check((await page.locator("h1").first().innerText()) === "我的书", `${scheme}: /books is 我的书`);
  check(
    (await page.getByTestId("my-books-browse").getAttribute("href")) === "/library",
    `${scheme}: links to /library`,
  );
  await page.screenshot({ path: join(OUT, `books-empty-${scheme}.png`) });

  await page.goto("/library?lang=zh", { waitUntil: "networkidle" });
  const h1 = await page.locator("h1").first().innerText();
  check(h1 === "书库" && !h1.includes("公版"), `${scheme}: /library is 书库 (${h1})`);
  check(
    (await page.getByTestId("books-add").count()) > 0,
    `${scheme}: each book has an add button`,
  );
  await page.screenshot({ path: join(OUT, `library-${scheme}.png`) });

  const r = await ctx.request.get("/books/fr/histoires-ou-contes-du-temps-pass%C3%A9", {
    maxRedirects: 0,
  });
  check(r.status() === 308, `${scheme}: a book not on the shelf: old link is 308 (${r.status()})`);
  check(
    (r.headers()["location"] ?? "").includes("/library/fr/histoires-ou-contes-du-temps-pass"),
    `${scheme}: …to /library (${r.headers()["location"]})`,
  );

  // Import my own book: a generated EPUB (text written for this test) with a cover.
  await page.goto("/books?lang=zh", { waitUntil: "networkidle" });
  await page.getByTestId("my-books-file").setInputFiles({
    name: "testgarten.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.from(await ownEpub()),
  });
  await page.waitForURL(/\/reader\/[^/]+$/, { timeout: budget(30000) });
  const id = page.url().split("/").pop();
  await page.getByTestId("reader-author").waitFor({ timeout: budget(15000) });
  check(
    (await page.getByTestId("reader-author").innerText()) === "Erika Probe",
    `${scheme}: the imported book opens in the reader with its author`,
  );
  await page.goto("/books?lang=zh", { waitUntil: "networkidle" });
  const own = page.locator('[data-testid="my-books-book"][data-origin="file"]');
  check((await own.count()) === 1, `${scheme}: the book is on My books`);
  check(
    (await page.locator('[data-testid="my-books-lang"][data-lang="de"]').count()) === 1,
    `${scheme}: under its language (de)`,
  );
  const cover = await ctx.request.get(`/api/books/mine/${id}/cover`);
  check(
    cover.ok() && cover.headers()["content-type"] === "image/png",
    `${scheme}: its cover is served to me (${cover.status()})`,
  );
  await page.screenshot({ path: join(OUT, `books-own-${scheme}.png`) });

  const other = await account(`books-other-${scheme}`);
  const theirs = await other.request.get(`/api/books/mine/${id}/cover`);
  check(
    theirs.status() === 404,
    `${scheme}: another account cannot see the cover (${theirs.status()})`,
  );
  const files = await (await other.request.get("/api/my/files")).json();
  check((files.items ?? []).length === 0, `${scheme}: nor the file`);
  await other.close();

  const mine = await (await ctx.request.get("/api/my/files")).json();
  check(
    (mine.items ?? []).some((f) => f.source === "books" && f.name === "testgarten.epub"),
    `${scheme}: the file is in My files under Books`,
  );
  await ctx.close();
}

/** A small EPUB 3, its text written for this QA, with a 1×1 PNG cover. */
async function ownEpub() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const x = (b) =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${b}</body></html>`;
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Der kleine Testgarten</dc:title><dc:creator>Erika Probe</dc:creator><dc:language>de</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="cov" href="cover.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    x(
      `<nav><ol><li><a href="c1.xhtml">Erstes Kapitel</a></li><li><a href="c2.xhtml">Zweites Kapitel</a></li></ol></nav>`,
    ),
  );
  zip.file(
    "OEBPS/c1.xhtml",
    x(
      "<h1>Erstes Kapitel</h1><p>Im Garten wächst ein kleiner Baum, und die Kinder spielen dort jeden Tag.</p>",
    ),
  );
  zip.file(
    "OEBPS/c2.xhtml",
    x(
      "<h1>Zweites Kapitel</h1><p>Am Abend gehen alle nach Hause und erzählen, was sie gesehen haben.</p>",
    ),
  );
  zip.file("OEBPS/cover.png", png);
  return zip.generateAsync({ type: "uint8array" });
}

check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : `\n✓ books QA passed (screenshots in ${OUT})`);
process.exit(failed ? 1 : 0);
