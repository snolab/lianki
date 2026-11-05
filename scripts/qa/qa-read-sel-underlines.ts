/**
 * The reader's selection keeps each familiarity underline in its own colour
 * (owner, 2026-11-05: on the iPhone, while text was selected every underline
 * turned the same colour, so the levels could not be told apart).
 *
 *   bun scripts/qa/qa-read-sel-underlines.ts [outDir]
 *
 * Needs no server. The page carries app/globals.css as it is and draws the
 * selection the way use-reader-select.ts does (markSelected: [data-sel] on
 * the elements, an element background). Words of two levels (l1, solid amber;
 * n, dotted blue) are selected together. Each word's underline is found by
 * difference: the word shot with its underline, then with every underline
 * turned off; the pixels that changed are the underline, and their mean
 * colour is compared. Inside the selection the two levels must differ as much
 * as they do outside it. WebKit and Chromium, light and dark. Silent (no
 * audio anywhere on the page; Chromium muted too).
 *
 * Exit code 1 on a failed check.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit, type Page } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const ROOT = join(import.meta.dir, "../..");
const OUT = process.argv[2] || join(ROOT, "test-results/read-sel-underlines");
mkdirSync(OUT, { recursive: true });

const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "qa-read-sel-underlines.page.ts")],
  target: "browser",
  format: "iife",
  tsconfig: join(ROOT, "tsconfig.json"),
});
if (!built.success) throw new AggregateError(built.logs, "page bundle failed");
const js = await built.outputs[0].text();

const html = `<!doctype html><html data-read-marks="all"><head><meta charset="utf-8">
<style>${css}</style>
<style>body{margin:0;padding:24px;font:32px/2 Georgia,serif;background:canvas;color:canvastext}</style>
</head><body><div class="lk-book"><p data-line="0">
<span data-t="0" data-f="l1" id="in1">bell</span> <span data-t="1" data-f="n" id="in2">bread</span>
<span data-t="2" data-f="l1" id="out1">bell</span> <span data-t="3" data-f="n" id="out2">bread</span>
</p></div><script>${js}</script></body></html>`;

let failed = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

/** RGBA pixels of an element's box, plus its size. */
async function pixels(page: Page, id: string) {
  const box = (await page.locator(`#${id}`).boundingBox())!;
  // Room below the box: the underline sits 0.24em under the baseline.
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height + 12 };
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    return Array.from(x.getImageData(0, 0, c.width, c.height).data);
  }, png.toString("base64"));
}

/** The mean colour of the pixels the underline paints: shot with it, minus shot without. */
async function underline(page: Page, id: string) {
  const on = await pixels(page, id);
  await page.evaluate(() => document.documentElement.setAttribute("data-read-marks", "none"));
  const off = await pixels(page, id);
  await page.evaluate(() => document.documentElement.setAttribute("data-read-marks", "all"));
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < on.length; i += 4) {
    const d =
      Math.abs(on[i] - off[i]) +
      Math.abs(on[i + 1] - off[i + 1]) +
      Math.abs(on[i + 2] - off[i + 2]);
    if (d < 24) continue;
    sum[0] += on[i];
    sum[1] += on[i + 1];
    sum[2] += on[i + 2];
    n++;
  }
  return n ? sum.map((v) => v / n) : null;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

for (const [name, type] of [
  ["webkit", webkit],
  ["chromium", chromium],
] as const) {
  const browser = await launchSilent(type);
  for (const scheme of ["light", "dark"] as const) {
    const tag = `${name}/${scheme}`;
    const ctx = await newSilentContext(browser, {
      viewport: { width: 520, height: 200 },
      colorScheme: scheme,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.setContent(html);
    const how = await page.evaluate(() => (window as unknown as { __select(): string }).__select());
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(OUT, `${name}-${scheme}.png`) });
    const [in1, in2, out1, out2] = [
      await underline(page, "in1"),
      await underline(page, "in2"),
      await underline(page, "out1"),
      await underline(page, "out2"),
    ];
    check(!!(in1 && in2 && out1 && out2), `${tag}: every word's underline is found (${how})`);
    if (in1 && in2 && out1 && out2) {
      const inside = dist(in1, in2);
      const outside = dist(out1, out2);
      check(
        inside > outside * 0.5,
        `${tag}: two levels' underlines differ inside the selection as outside (${inside.toFixed(0)} vs ${outside.toFixed(0)})`,
      );
    }
    await ctx.close();
  }
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
