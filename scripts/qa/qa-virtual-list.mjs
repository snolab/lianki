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
// row again after opening one and going Back. On /data (random access, 400
// more cards): aria-rowcount is the whole total at once, only the first pages
// are asked for, a jump to the end loads the last row and skips the pages in
// between, and every row is still reachable by scrolling.
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

/** When a reachability check fails: where the page and the list stood, for the log. */
const listState = (page) =>
  page.evaluate(() => {
    const idx = [...document.querySelectorAll("[data-index]")].map((r) => +r.dataset.index);
    const list = document.querySelector('[role="list"], tbody');
    const r = list?.getBoundingClientRect();
    return JSON.stringify({
      scrollY: Math.round(scrollY),
      docH: document.documentElement.scrollHeight,
      vh: innerHeight,
      listTop: r ? Math.round(r.top + scrollY) : null,
      listH: r ? Math.round(r.height) : null,
      minIdx: idx.length ? Math.min(...idx) : null,
      maxIdx: idx.length ? Math.max(...idx) : null,
      end: !!document.querySelector('[data-testid="vlist-end"]'),
      retry: !!document.querySelector('[data-testid="vlist-retry"]'),
      htmlClass: document.documentElement.className,
      under: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.outerHTML.slice(0, 120),
    });
  });

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

  // /list (LiCards): the same list over the page cards, from /api/fsrs/list.
  const now = Date.now();
  const push = await ctx.request.post("/api/fsrs/bulk-upsert", {
    headers: { origin: BASE },
    data: {
      notes: Array.from({ length: N }, (_, i) => ({
        url: `https://example.com/qa-vlist-${i}`,
        title: `Card ${String(i).padStart(3, "0")}`,
        card: {
          due: new Date(now + (i + 1) * 3600000).toISOString(),
          stability: 0,
          difficulty: 0,
          elapsed_days: 0,
          scheduled_days: 0,
          reps: 0,
          lapses: 0,
          state: 0,
        },
        log: [],
        hlc: { timestamp: now, counter: i, deviceId: "qa" },
      })),
    },
  });
  check(push.ok(), `${name}: /list: ${N} cards pushed (${push.status()})`);
  await page.goto("/list", { waitUntil: "networkidle" });
  await page.locator('[data-testid="list-card"]').first().waitFor();
  const card0 = page.locator('[data-testid="cards-list"] [role="listitem"]').first();
  check(
    (await card0.getAttribute("aria-setsize")) === String(N),
    `${name}: /list aria-setsize ${N}`,
  );
  check(
    /Card 000/.test(await card0.innerText()),
    `${name}: /list soonest due first (${(await card0.innerText()).slice(0, 40)})`,
  );
  await page.mouse.move(vp.width / 2, vp.height / 2);
  const cardsSeen = new Set();
  let cardsMax = 0;
  for (let step = 0; step < 300; step++) {
    const ts = await page.locator('[data-testid="list-card"] a').allTextContents();
    ts.forEach((t) => cardsSeen.add(t.trim()));
    cardsMax = Math.max(cardsMax, ts.length);
    if ((await page.locator('[data-testid="vlist-end"]').count()) && cardsSeen.size >= N) break;
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(80);
  }
  check(cardsSeen.size === N, `${name}: /list all ${N} cards reachable (${cardsSeen.size})`);
  if (cardsSeen.size !== N) console.log(`  /list state: ${await listState(page)}`);
  check(cardsMax < N, `${name}: /list only a window in the DOM (max ${cardsMax})`);
  // Delete takes the row out in place: no reload, the position stays.
  const y0 = await page.evaluate(() => window.scrollY);
  // The card on screen at the centre, not the last one in the DOM (that one is
  // in the overscan below the fold; scrolling to click it re-windows the list).
  const victimKey = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="cards-list"] [data-key]')];
    const mid = innerHeight / 2;
    const on = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= 0 && b.bottom <= innerHeight;
    });
    on.sort((a, b) => {
      const da = Math.abs(a.getBoundingClientRect().top - mid);
      const db = Math.abs(b.getBoundingClientRect().top - mid);
      return da - db;
    });
    return on[0]?.getAttribute("data-key") ?? null;
  });
  const victim = page.locator(`[data-key="${victimKey}"] [data-testid="list-card"]`);
  const victimTitle = (await victim.locator("a").innerText()).trim();
  page.once("dialog", (d) => d.accept());
  await victim.locator("button").last().click();
  await page
    .locator('[data-testid="list-card"] a', { hasText: victimTitle })
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  check(
    (await page.locator('[data-testid="list-card"] a', { hasText: victimTitle }).count()) === 0,
    `${name}: /list delete removes "${victimTitle}" in place`,
  );
  const y1 = await page.evaluate(() => window.scrollY);
  // A reload would land at the top; rows re-measuring after the delete may move it a little.
  check(
    y1 > 0 && Math.abs(y1 - y0) < vp.height,
    `${name}: /list no jump to the top after delete (${y0} → ${y1})`,
  );
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(OUT, `list-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });

  // /data's card table (cloud): random access — the table is its full length at
  // once and fetches only the pages under the viewport. MORE extra cards make
  // it long enough (many pages of `lists.batchSize`) that a jump to the end
  // must skip pages in between.
  const MORE = 400;
  const more = await ctx.request.post("/api/fsrs/bulk-upsert", {
    headers: { origin: BASE },
    data: {
      notes: Array.from({ length: MORE }, (_, i) => ({
        url: `https://example.com/qa-vlist-more-${i}`,
        title: `More ${String(i).padStart(3, "0")}`,
        card: {
          due: new Date(now + (N + i + 1) * 3600000).toISOString(),
          stability: 0,
          difficulty: 0,
          elapsed_days: 0,
          scheduled_days: 0,
          reps: 0,
          lapses: 0,
          state: 0,
        },
        log: [],
        hlc: { timestamp: now, counter: N + i, deviceId: "qa" },
      })),
    },
  });
  check(more.ok(), `${name}: /data: ${MORE} more cards pushed (${more.status()})`);
  /** Pages the table asked for (its requests carry `sort`; the stats diff does not). */
  const asked = [];
  /** The page size the table asks with (`size`): rendered rows are fewer, being virtual. */
  let askedSize = 0;
  page.on("request", (rq) => {
    const u = new URL(rq.url());
    if (u.pathname === "/api/fsrs/list" && u.searchParams.has("sort")) {
      asked.push(Number(u.searchParams.get("page")));
      askedSize = Number(u.searchParams.get("size")) || askedSize;
    }
  });
  await page.goto("/data?store=cloud", { waitUntil: "networkidle" });
  await page.locator('[data-testid="cards-total"]').waitFor();
  await page.locator("tbody tr[data-key]").first().waitFor();
  const dataTotal = Number((await page.locator('[data-testid="cards-total"]').innerText()).trim());
  check(dataTotal === N - 1 + MORE, `${name}: /data total ${dataTotal}`);
  check(
    (await page.locator("table[data-sparse]").getAttribute("aria-rowcount")) ===
      String(dataTotal + 1),
    `${name}: /data aria-rowcount = total + header`,
  );
  const pageSize = askedSize || (await page.locator("tbody tr[data-key]").count());
  const firstAsked = [...new Set(asked)];
  check(
    firstAsked.length > 0 && Math.max(...firstAsked) <= 2,
    `${name}: /data asks only the first pages at first (${firstAsked})`,
  );
  // Jump straight to the end: the last row loads; the pages in between never do.
  asked.length = 0;
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="data-scroll-cloud"]');
    box.scrollTop = box.scrollHeight;
  });
  await page
    .locator(`tbody tr[data-key][data-index="${dataTotal - 1}"]`)
    .waitFor({ timeout: 10000 })
    .catch(() => {});
  check(
    (await page.locator(`tbody tr[data-key][data-index="${dataTotal - 1}"]`).count()) === 1,
    `${name}: /data a jump to the end loads the last row`,
  );
  const jumpAsked = [...new Set(asked)].sort((a, b) => a - b);
  const lastPage = Math.floor((dataTotal - 1) / Math.max(1, pageSize));
  check(
    jumpAsked.length > 0 && jumpAsked.length <= 4 && Math.min(...jumpAsked) >= lastPage - 3,
    `${name}: /data the jump skips the pages in between (asked ${jumpAsked}, last ${lastPage})`,
  );
  await page.screenshot({ path: join(OUT, `data-jump-${name}.png`) });
  await page.evaluate(() => {
    document.querySelector('[data-testid="data-scroll-cloud"]').scrollTop = 0;
  });
  await page.waitForTimeout(400);
  check(
    (await page.getByRole("button", { name: /^[‹›]$/ }).count()) === 0,
    `${name}: /data no page buttons`,
  );
  await page.mouse.move(vp.width / 2, vp.height / 2);
  // Every row the table ever renders is recorded in the page (a sample per
  // step could miss a row that is in the DOM only between two samples).
  await page.evaluate(() => {
    const seen = (window.__vlSeen = new Set());
    const grab = () =>
      document.querySelectorAll("tbody tr[data-key]").forEach((r) => seen.add(r.dataset.key));
    grab();
    new MutationObserver(grab).observe(document.body, { childList: true, subtree: true });
  });
  const dataSeen = new Set();
  let dataMax = 0;
  for (let step = 0; step < 400; step++) {
    const [ts, all] = await page.evaluate(() => [
      document.querySelectorAll("tbody tr[data-key]").length,
      [...window.__vlSeen],
    ]);
    all.forEach((t) => dataSeen.add(t));
    dataMax = Math.max(dataMax, ts);
    if (dataSeen.size >= dataTotal) break;
    // A batch that failed under load: the list's own Try again.
    const retry = page.locator('[data-testid="vlist-retry"]');
    if (await retry.count()) await retry.click();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(100);
  }
  check(dataSeen.size === dataTotal, `${name}: /data all rows reachable (${dataSeen.size})`);
  if (dataSeen.size !== dataTotal) console.log(`  /data state: ${await listState(page)}`);
  check(dataMax < dataTotal, `${name}: /data only a window of rows (max ${dataMax})`);
  await page.screenshot({ path: join(OUT, `data-${name}.png`) });

  check(errs.length === 0, `${name}: no page errors (${errs.join("; ")})`);
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
