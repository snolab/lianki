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
// - a binary file: a plain error, nothing sent;
// - /words: the Import button at the top opens the panel; "Preset word sets"
//   jumps to the Add a list tree; "CSV or Excel table" shows the templates,
//   which download (header row, BOM) and, uploaded back (.xlsx, then .csv),
//   preview and add like any list; an old .xls gets a plain error.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
    await page.goto("/words?lang=en");
    await page.waitForTimeout(3000);
    check(
      (await page.locator('[data-qa="words-import-button"]').count()) === 0,
      "flag off: no Import button on /words",
    );
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
    // /words → Import (docs/import-material.md, "On /words"): the button opens
    // the panel; the templates download with the header row; the filled-in
    // .xlsx and .csv go through the same preview and "Add N words".
    await page.goto("/words?lang=en");
    const importBtn = page.locator('[data-qa="words-import-button"]');
    await importBtn.waitFor({ timeout: 30000 });
    const btnBox = await importBtn.boundingBox();
    check(!!btnBox && btnBox.y < 260, `/words: Import button at the top (y=${btnBox?.y})`);
    await importBtn.click();
    const panel = page.locator('[data-qa="words-import-panel"]');
    await panel.waitFor({ timeout: 5000 });
    check(
      (await panel
        .locator('[data-qa="words-import-preset"], [data-qa="words-import-table"]')
        .count()) === 2,
      "/words: the panel lists preset sets and a CSV / Excel table",
    );
    await page.locator('[data-qa="words-import-preset"]').click();
    await page.waitForTimeout(800);
    check((await panel.count()) === 0, "preset sets: the panel closes");
    check(
      await page.locator("[data-add-tree]").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top < innerHeight && r.bottom > 0;
      }),
      "preset sets: the 'Add a list' tree is in view",
    );
    await importBtn.click();
    await page.locator('[data-qa="words-import-table"]').click();
    const body = page.locator('[data-qa="words-import-table-body"]');
    await body.locator('[data-qa="wordlist-templates"]').waitFor({ timeout: 15000 });
    await page.screenshot({ path: join(OUT, `words-panel-${scheme}.png`), fullPage: true });

    const save = async (sel, name) => {
      const [dl] = await Promise.all([page.waitForEvent("download"), body.locator(sel).click()]);
      const path = join(OUT, `${scheme}-${name}`);
      await dl.saveAs(path);
      return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
    };
    const xlsx = await save('[data-qa="wordlist-template-xlsx"]', "template.xlsx");
    check(
      xlsx.name === "lianki-words-template.xlsx" && xlsx.bytes.subarray(0, 2).toString() === "PK",
      `XLSX template downloads (${xlsx.name}, ${xlsx.bytes.length} bytes)`,
    );
    const csv = await save('[data-qa="wordlist-template-csv"]', "template.csv");
    const csvText = csv.bytes.toString("utf8");
    check(
      csvText.startsWith("﻿Word,Meaning,Example\r\n") && /\r\napple,/.test(csvText),
      "CSV template: BOM, the English header row, example rows",
    );

    // The .xlsx template, uploaded as it is: its 3 example words.
    await body.locator('[data-qa="wordlist-file"]').setInputFiles({
      name: "my-words.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: xlsx.bytes,
    });
    const box2 = body.locator('[data-qa="wordlist-preview-box"]');
    await box2.waitFor({ timeout: 15000 });
    const sum2 = await box2.innerText();
    check(/3 new/.test(sum2), `xlsx preview: 3 new (${sum2.split("\n")[0]})`);
    check(/Columns read from the header row/.test(sum2), "xlsx preview: the header row was read");
    await body.locator('[data-qa="wordlist-lang"]').selectOption("en");
    await body.locator('[data-qa="wordlist-add"]').click();
    const done2 = body.locator('[data-qa="wordlist-done"]');
    await done2.waitFor({ timeout: 15000 });
    check(/Added 3 words to “my-words”/.test(await done2.innerText()), "xlsx: 3 words added");
    await page
      .locator("[data-list-row]")
      .filter({ hasText: "my-words" })
      .first()
      .waitFor({ timeout: 15000 });
    check(true, "/words: the new list shows in the lists without a reload");

    // The CSV template next: the same words, so all already there.
    await body.getByRole("button", { name: /import another/i }).click();
    await body.locator('[data-qa="wordlist-file"]').setInputFiles({
      name: "template.csv",
      mimeType: "text/csv",
      buffer: csv.bytes,
    });
    await box2.waitFor({ timeout: 15000 });
    const sum3 = await box2.innerText();
    check(
      /0 new/.test(sum3) && /3 already in your words/.test(sum3),
      "csv template: 3 already there",
    );

    // An old .xls: a plain error naming the fix.
    await body.locator('[data-qa="wordlist-file"]').setInputFiles({
      name: "old.xls",
      mimeType: "application/vnd.ms-excel",
      buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
    });
    const err2 = body.locator('[data-qa="wordlist-error"]');
    await err2.waitFor({ timeout: 10000 });
    check(
      /old Excel file/.test(await err2.innerText()),
      "an .xls: 'old Excel file', save as .xlsx",
    );
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      "/words: no sideways scroll at phone width",
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
