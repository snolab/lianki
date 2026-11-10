// The shared virtual list (app/components/VirtualList.tsx) on /reader: no
// pages, only the rows near the viewport in the DOM, more loaded as you
// scroll, the centre row brought back after Back. Silent; iPhone, 360 px and
// desktop, light and dark screenshots.
//
//   QA_BASE=http://localhost:3417 bun scripts/qa/qa-virtual-list.mjs [outDir]
//
// Signs up a throwaway account, adds N text materials through the API (more
// than two batches of `lists.batchSize`), and checks: role list with
// aria-setsize N, no Prev / Next / "Page n of m", fewer rows in the DOM than
// N, every title reachable by scrolling, an end line at the bottom, ↓ moves
// focus to the next row, and the row at the viewport's centre is the centre
// row again after opening one and going Back.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/virtual-list";
const PW = "qa-test-pass-1234";
const N = 75;
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);

for (const [name, device] of [
  ["iphone", devices["iPhone 13"]],
  ["w360", { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true }],
  ["desktop", { viewport: { width: 1280, height: 860 } }],
]) {
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+vlist${name}${Date.now()}@lianki.test`, password: PW, name: "QA List" },
    headers: { origin: BASE },
  });
  check(r.ok(), `${name}: sign-up (${r.status()})`);
  let added = 0;
  for (let i = 1; i <= N; i++) {
    const title = `Text ${String(i).padStart(3, "0")}`;
    const a = await ctx.request.post("/api/read", {
      data: { title, content: `${title} first line.\nAnother line.` },
      headers: { origin: BASE },
    });
    if (a.ok()) added++;
  }
  check(added === N, `${name}: added ${added}/${N} materials`);

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/reader", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-row"]').first().waitFor();

  const list = page.locator('[data-testid="read-list"] [role="list"]');
  check((await list.count()) === 1, `${name}: one role=list`);
  const first = page.locator('[role="listitem"]').first();
  check((await first.getAttribute("aria-setsize")) === String(N), `${name}: aria-setsize ${N}`);
  check((await first.getAttribute("aria-posinset")) === "1", `${name}: aria-posinset 1`);
  const pager = await page
    .getByRole("button", { name: /^(Prev|Next)$/ })
    .count()
    .then(async (n) => n + (await page.getByText(/Page \d+ of \d+/).count()));
  check(pager === 0, `${name}: no page controls`);
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  check(wide, `${name}: no sideways scroll`);

  // Scroll to the end: every title shows up, the DOM keeps only a window.
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2);
  const seen = new Set();
  let maxRows = 0;
  for (let step = 0; step < 200; step++) {
    const titles = await page.locator('[data-testid="read-row-title"]').allTextContents();
    titles.forEach((t) => seen.add(t.trim()));
    maxRows = Math.max(maxRows, titles.length);
    if ((await page.locator('[data-testid="vlist-end"]').count()) && seen.size >= N) break;
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(80);
  }
  check(seen.size === N, `${name}: all ${N} titles reachable by scrolling (${seen.size})`);
  check(maxRows < N, `${name}: only a window in the DOM (max ${maxRows} of ${N})`);
  check(
    (await page.locator('[data-testid="vlist-end"]').count()) === 1,
    `${name}: end line at the bottom`,
  );
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(OUT, `end-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });

  // Keyboard: ↓ from a row's link moves focus to the next row.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.locator('[role="listitem"][data-index="0"] a').first().focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const idx = await page.evaluate(() => document.activeElement?.getAttribute("data-index"));
  check(idx === "1", `${name}: ↓ focuses the next row (${idx})`);

  // Centre row back after Back.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
  await page.waitForTimeout(500);
  const centreKey = () =>
    page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return el?.closest("[data-key]")?.getAttribute("data-key") ?? null;
    });
  let before = await centreKey();
  for (let i = 0; i < 5 && !before; i++) {
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(300);
    before = await centreKey();
  }
  check(!!before, `${name}: a row at the centre (${before})`);
  await page.locator(`[data-key="${before}"] a`).first().click();
  await page.waitForURL(/\/reader\/[^/]+$/);
  await page.goBack({ waitUntil: "networkidle" });
  await page.locator('[data-testid="read-row"]').first().waitFor();
  let after = null;
  for (let i = 0; i < 30 && after !== before; i++) {
    await page.waitForTimeout(150);
    after = await centreKey();
  }
  check(after === before, `${name}: the centre row is back at the centre (${after})`);
  await page.screenshot({ path: join(OUT, `restored-${name}.png`) });

  check(errs.length === 0, `${name}: no page errors (${errs.join("; ")})`);
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
