// Import a word list on /import, M1 (docs/import-material.md). Silent; iPhone
// size, light and dark screenshots.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-import-wordlist.mjs [outDir]
//
// In qa:all (suite import-wordlist), or against any local server on local D1:
// it turns `import.any` on in the local D1 for the middle part and deletes the
// row at the end.
//
// - flag off, not the owner: no section on /import, and the route answers 404;
// - flag on: a CSV file dropped in shows the preview counts (new / skipped),
//   "Add N words" makes a /words list, and the recent-imports list shows it;
// - the same list pasted again: everything is "already in your words";
// - a binary file: a plain error, nothing sent.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/import-wordlist";
const PW = "qa-test-pass-1234";
const FLAG = "import.any";
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

const CSV = [
  "Word,Meaning,Example",
  'hola,hello,"¡Hola, amigo!"',
  "gato,cat,",
  "perro,dog,",
  "gato,cat again,",
  ",no word here,",
].join("\n");

const preview = (ctx, text) =>
  ctx.request.post("/api/import/words", {
    data: { step: "preview", text, fileName: "qa.csv" },
    headers: { origin: BASE, "content-type": "application/json" },
  });

async function signUp(ctx, tag) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+wl${tag}${Date.now()}@lianki.test`, password: PW, name: "QA WL" },
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
    await page.goto("/import");
    check(
      (await page.locator('[data-qa="wordlist-import"]').count()) === 0,
      "flag off: no word-list section on /import",
    );
    check((await preview(ctx, CSV)).status() === 404, "flag off: the route is 404");
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
    await signUp(ctx, scheme);
    // The server caches flags for 30 s (docs/feature-flags.md): wait for the switch to reach it.
    for (let i = 0; i < 25 && (await preview(ctx, "x")).status() === 404; i++)
      await new Promise((r) => setTimeout(r, 2000));

    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto("/import?lang=en");
    const section = page.locator('[data-qa="wordlist-import"]');
    await section.waitFor({ timeout: 30000 });

    // A binary file: a plain error.
    await page.locator('[data-qa="wordlist-file"]').setInputFiles({
      name: "deck.apkg",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]),
    });
    await page.locator('[data-qa="wordlist-error"]').waitFor({ timeout: 10000 });
    check(
      /not a text file/i.test(await page.locator('[data-qa="wordlist-error"]').innerText()),
      "a binary file: 'not a text file'",
    );

    // The CSV: preview counts, then add.
    await page
      .locator('[data-qa="wordlist-file"]')
      .setInputFiles({ name: "qa-spanish.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
    const box = page.locator('[data-qa="wordlist-preview-box"]');
    await box.waitFor({ timeout: 15000 });
    const summary = await box.innerText();
    check(/3 new/.test(summary), `preview: 3 new (${summary.split("\n")[0]})`);
    check(/2 skipped/.test(summary), "preview: 2 skipped (a repeat and a row with no word)");
    check(/Columns read from the header row/.test(summary), "preview: the header row was read");
    await page.locator('[data-qa="wordlist-lang"]').selectOption("es");
    await page.screenshot({ path: join(OUT, `preview-${scheme}.png`), fullPage: true });
    await page.locator('[data-qa="wordlist-add"]').click();
    const done = page.locator('[data-qa="wordlist-done"]');
    await done.waitFor({ timeout: 15000 });
    check(/Added 3 words to “qa-spanish”/.test(await done.innerText()), "done: 3 words added");
    await page.screenshot({ path: join(OUT, `done-${scheme}.png`), fullPage: true });
    const href = await section.locator('a[href^="/words?list="]').first().getAttribute("href");
    const listId = href?.split("=")[1];
    const entries = await (await ctx.request.get(`/api/words/lists/${listId}/entries`)).json();
    const terms = (entries.entries ?? []).map((e) => e.term);
    check(
      terms.join() === "hola,gato,perro",
      `the new list holds the new words in order (${terms.join()})`,
    );
    check(/qa-spanish\.csv/.test(await section.innerText()), "recent imports list the file");

    // The same words again: nothing new.
    const again = await (await preview(ctx, CSV)).json();
    check(
      again.fresh === 0 && again.have === 3,
      `again: 0 new, 3 already have (${again.fresh}/${again.have})`,
    );
    check(errs.length === 0, `no page errors (${errs.join(" | ")})`);
    await ctx.close();
  }
} finally {
  try {
    setFlag(false);
  } catch (e) {
    console.error(e);
  }
  await browser.close();
}
console.log(failed ? `✗ ${failed} failed` : "✓ all passed");
process.exit(failed ? 1 : 0);
