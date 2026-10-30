/**
 * Does a disposed word-clip pool really let its <audio> elements and Web
 * Audio nodes be collected? (docs/hot-core.md, step 0.)
 *
 *   bun scripts/qa/clip-pool-gc.ts                 # chromium + webkit, 20 pools each
 *   GC_BROWSERS=chromium GC_ROUNDS=50 bun scripts/qa/clip-pool-gc.ts
 *
 * For each browser, three fresh pages, one per mode:
 *   plain          pool without Web Audio, disposed       (the baseline: GC works)
 *   wired-dispose  pool through the AudioContext, disposed (what a hot swap will do)
 *   wired-drop     pool through the AudioContext, dropped without dispose (the control)
 *   wired-close    as wired-dispose, then the AudioContext closed (is it the context that holds them?)
 * Each mode makes GC_ROUNDS pools that each play GC_CLIPS silent clips, two
 * at a time (so every pool grows to its max of 4 elements), then forces a GC
 * and counts the elements and nodes still alive through WeakRefs.
 * Chromium's GC is forced over CDP; WebKit has none, so it gets allocation
 * pressure across several tasks, which is a weaker guarantee: a "kept" there
 * is a hint, a "collected" is a fact.
 *
 * Silent and muted: generated silent WAVs, a 0-gain node in front of the
 * speakers, and Chromium's --mute-audio. Needs no server.
 *
 * Exit code 1 if, in a browser whose GC could be forced, the disposed wired
 * pools made or left alive more than one pool's worth (4 elements).
 *
 * Results, 2026-10-31 (Playwright chromium-1208 and webkit-2248 on macOS,
 * headless; 20 pools × 8 clips):
 *
 *   chromium  plain           0/40 elements alive              collected
 *   chromium  wired-drop     40/40 elements, 80/80 nodes        kept: the #336 leak
 *   chromium  wired-dispose  40/40 elements, 40/80 nodes        before spares: disconnect frees
 *                                                               the gains, never the elements
 *   chromium  wired-close     0/40                              closing the context frees them
 *   chromium  wired-dispose   2 made, 2/2 alive, 2/42 nodes     with spares: one set, reused
 *   webkit    plain           0/40 (by pressure)                collected
 *   webkit    wired-*         clips never end: headless WebKit renders no media through
 *                             an AudioContext, so these rows are of unplayed elements and
 *                             say nothing about iOS; check on a device.
 */
import { chromium, webkit, type Browser, type Page } from "playwright";
import { join } from "node:path";

const ROUNDS = Number(process.env.GC_ROUNDS || 20);
const CLIPS = Number(process.env.GC_CLIPS || 8);
const BROWSERS = (process.env.GC_BROWSERS || "chromium,webkit").split(",");
const MODES = ["plain", "wired-dispose", "wired-drop", "wired-close"] as const;
const ORIGIN = "http://clip-pool-gc.test";

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "clip-pool-gc-page.ts")],
  target: "browser",
  format: "iife",
});
if (!built.success) throw new Error(built.logs.join("\n"));
const js = await built.outputs[0].text();
const html = `<!doctype html><meta charset="utf-8"><button id="go">start</button><script>${js}</script>`;

type Row = {
  browser: string;
  mode: string;
  made: { elements: number; nodes: number };
  alive: { elements: number; nodes: number };
  played: { ok: number; failed: number };
  /** How far the AudioContext's clock ran: 0 means it never rendered. */
  audioTime: number;
  forced: boolean;
};

async function collect(page: Page, browser: string) {
  if (browser === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    for (let i = 0; i < 4; i++) {
      await cdp.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(100);
    }
    return true;
  }
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => (globalThis as any).__gc.pressure(64));
    await page.waitForTimeout(150);
  }
  return false;
}

async function probe(b: Browser, name: string, mode: (typeof MODES)[number]): Promise<Row> {
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.route(`${ORIGIN}/**`, (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => {
    (globalThis as any).__started = null;
    document.getElementById("go")!.addEventListener("click", () => {
      (globalThis as any).__started = (globalThis as any).__gc.start();
    });
  });
  await page.click("#go"); // a trusted gesture: the AudioContext may run
  const state = await page.evaluate(() => (globalThis as any).__started);
  if (state !== "running") console.warn(`  ${name}: AudioContext is ${state}`);
  const made = await page.evaluate(([m, r, c]) => (globalThis as any).__gc.run(m, r, c), [
    mode,
    ROUNDS,
    CLIPS,
  ] as const);
  const forced = await collect(page, name);
  const alive = await page.evaluate(() => (globalThis as any).__gc.alive());
  await ctx.close();
  return {
    browser: name,
    mode,
    made,
    alive,
    played: made.played,
    audioTime: made.audioTime,
    forced,
  };
}

const rows: Row[] = [];
for (const name of BROWSERS) {
  const type = name === "webkit" ? webkit : chromium;
  const b = await type.launch(
    name === "chromium"
      ? { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] }
      : {},
  );
  for (const mode of MODES) {
    const row = await probe(b, name, mode);
    rows.push(row);
    console.log(
      `${name.padEnd(9)} ${mode.padEnd(14)} elements ${row.alive.elements}/${row.made.elements} alive` +
        ` · nodes ${row.alive.nodes}/${row.made.nodes} alive` +
        ` · clips ended ${row.played.ok}, failed ${row.played.failed}` +
        ` · audio clock ${row.audioTime} ms` +
        (row.forced ? " · GC forced" : " · GC by pressure only"),
    );
  }
  await b.close();
}

if (process.env.GC_OUT) await Bun.write(process.env.GC_OUT, JSON.stringify(rows, null, 2));
const bad = rows.filter(
  (r) => r.forced && r.mode === "wired-dispose" && (r.alive.elements > 4 || r.made.elements > 4),
);
if (bad.length) {
  console.error(`disposed pools piled up elements: ${bad.map((r) => r.browser).join(", ")}`);
  process.exit(1);
}
