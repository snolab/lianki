/**
 * One selection at a time in the reader (owner, 2026-11-05 03:00 JST, iPhone
 * PWA /read: "连点两个不同词，两个都会高亮"). A tap on another word starts a new
 * selection and the old one goes; only quick taps on the same spot climb
 * word → phrase → sentence → paragraph.
 *
 *   bun scripts/qa/qa-read-sel-one.ts
 *
 * Cause: the selection was a CSS Custom Highlight (`::highlight(lk-sel)`) in
 * WebKit since #543, and on the iPhone a replaced highlight stayed painted on
 * the words tapped before. It is now [data-sel] on the elements in every
 * engine (markSelected), each paint taking it off everything else.
 *
 * Needs no server: the page mounts the real hook (use-reader-select.ts) over a
 * small book with app/globals.css. After each tap, everything that could draw
 * a selection is read: any `lk-sel` CSS highlight (there must be none) and
 * every [data-sel] element; together they must hold exactly the unit tapped.
 * WebKit (iPhone) and Chromium (Android phone), touch taps. Silent.
 *
 * Exit code 1 on a failed check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, webkit, type Page } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const ROOT = join(import.meta.dir, "../..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "qa-read-sel-one.page.tsx")],
  target: "browser",
  format: "iife",
  tsconfig: join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!built.success) throw new AggregateError(built.logs, "page bundle failed");
const js = await built.outputs[0].text();
const html = `<!doctype html><html data-read-marks="all"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><style>${css}</style>
<style>body{margin:0;padding:16px;font:22px/2 Georgia,serif;background:canvas;color:canvastext}</style>
</head><body><div id="root"></div></body></html>`;

let failed = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

/** What is drawn as selected now: the highlight's text and the marked elements' text. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights;
    const hl = reg?.get("lk-sel");
    return [
      ...(hl ? [...hl].map((r) => r.toString().trim()) : []),
      ...[...document.querySelectorAll("[data-sel]")].map((e) => e.textContent!.trim()),
    ].join(" ");
  });

for (const [name, type, dev] of [
  ["webkit", webkit, devices["iPhone 13"]],
  ["chromium", chromium, devices["Pixel 7"]],
] as const) {
  const browser = await launchSilent(type);
  const ctx = await newSilentContext(browser, { ...dev });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.setContent(html);
  // Inline <script> would end at the bundle's own "</script>" strings: a tag instead.
  await page.addScriptTag({ content: js });
  await page.waitForSelector("#w0-1");
  const tap = async (id: string) => {
    const b = (await page.locator(`#${id}`).boundingBox())!;
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  };
  const rest = () => page.waitForTimeout(500);

  await tap("w0-1");
  await rest();
  check((await drawn(page)) === "gift", `${name}: a tap selects the word (${await drawn(page)})`);
  await tap("w1-6");
  await rest();
  check(
    (await drawn(page)) === "that",
    `${name}: a tap on another word moves the selection there, the first one goes (${await drawn(page)})`,
  );
  // Quickly, as a combo would be: another word still starts over.
  await tap("w0-8");
  await page.waitForTimeout(80);
  await tap("w1-2");
  await rest();
  check(
    (await drawn(page)) === "and",
    `${name}: two quick taps on two words select only the second (${await drawn(page)})`,
  );
  // The same spot twice, quickly: the phrase; then another word: only it.
  await tap("w0-3");
  await page.waitForTimeout(80);
  await tap("w0-3");
  await rest();
  check(
    (await drawn(page)) === "of the magi",
    `${name}: two quick taps on one word climb to its phrase (${await drawn(page)})`,
  );
  await tap("w1-0");
  await rest();
  check(
    (await drawn(page)) === "one",
    `${name}: after the phrase, a tap elsewhere selects only that word (${await drawn(page)})`,
  );
  check(!errs.length, `${name}: no page errors ${errs.join("; ")}`);
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
