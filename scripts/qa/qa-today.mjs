// /today, today's goal (lib/today/goal.ts, app/(app)/today). Silent; iPhone
// size, light and dark, screenshots of each.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-today.mjs [outDir]
//
// `today.goal` is on by default. For each colour scheme, a new account with
// one catalog list:
// - the page shows the single number, the same as /api/words/lists' due sum;
// - light: gold ground, seal ink; dark: seal ground, gold ink (computed styles);
// - the progress bar is labelled and in range; Start goes to /words;
// - the rail and /home link to it; a guest is sent to sign in.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/today";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const browser = await launchSilent(chromium);

async function pass(scheme) {
  console.log(`— ${scheme}`);
  const ctx = await newSilentContext(browser, { ...devices["iPhone 13"], colorScheme: scheme });
  await ctx.addInitScript(() => localStorage.setItem("lk:first-run", "account"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => {
    if (!e.message.includes("Turnstile")) errs.push(e.message);
  });

  // A guest first: sent to sign in.
  await page.goto(`${BASE}/today`, { waitUntil: "domcontentloaded" });
  check(/\/sign-in/.test(page.url()), `${scheme}: a guest is sent to sign in`);

  const headers = { origin: BASE };
  const up = await page.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: { email: `qa+today-${scheme}-${Date.now()}@lianki.test`, password: PW, name: "QA Today" },
    headers,
  });
  check(up.ok(), `${scheme}: sign-up (${up.status()})`);
  const catalog = await (await page.request.get(`${BASE}/words/index.json`)).json();
  const first = catalog.lists.find((c) => c.lang === "fr") ?? catalog.lists[0];
  const made = await page.request.post(`${BASE}/api/words/lists`, {
    data: { name: first.name, lang: first.lang, source: first.id },
    headers,
  });
  check(made.ok(), `${scheme}: a list (${made.status()})`);

  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  const left = page.locator("[data-today-left]");
  await page.waitForFunction(
    () => document.querySelector("[data-today-left]")?.getAttribute("data-today-left") !== "",
    null,
    { timeout: 15000 },
  );
  const lists = await (await page.request.get(`${BASE}/api/words/lists`)).json();
  const due = (lists.lists ?? []).reduce((s, l) => s + (l.due ?? 0), 0);
  check(
    Number(await left.getAttribute("data-today-left")) === due,
    `${scheme}: the number is /words's due sum (${due})`,
  );
  const digits = ((await page.locator("[data-today]").innerText()).match(/\d+/g) ?? []).length;
  check(digits <= 1, `${scheme}: one number on the page (${digits})`);

  const bar = page.locator('[role="progressbar"]');
  const now = Number(await bar.getAttribute("aria-valuenow"));
  check(
    (await bar.getAttribute("aria-label"))?.length > 0 && now >= 0 && now <= 100,
    `${scheme}: progress bar labelled, ${now}%`,
  );

  const colours = await page.locator("[data-today]").evaluate((m) => {
    const s = getComputedStyle(m);
    return { bg: s.backgroundColor, ink: s.color };
  });
  // oklch(0.89 0.12 86) is the gold (light, high L); oklch(0.49 0.2 22.3) the seal.
  const L = (c) => Number((/oklch\(([\d.]+)/.exec(c) ?? [])[1] ?? Number.NaN);
  const gold = (c) => L(c) > 0.8;
  const seal = (c) => L(c) < 0.6;
  check(
    scheme === "light"
      ? gold(colours.bg) && seal(colours.ink)
      : seal(colours.bg) && gold(colours.ink),
    `${scheme}: ${scheme === "light" ? "gold ground, red ink" : "red ground, gold ink"} (${colours.bg} / ${colours.ink})`,
  );
  const width = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check(width, `${scheme}: no sideways scroll`);
  await page.screenshot({ path: join(OUT, `today-${scheme}.png`) });

  await page.locator("[data-today-start]").click();
  await page.waitForURL(/\/words/, { timeout: 15000 });
  check(true, `${scheme}: Start goes to /words`);

  await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await page
    .locator("[data-home-today]")
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  check(await page.locator("[data-home-today]").isVisible(), `${scheme}: /home links to it`);
  // The rail: at a desktop width, with the same session.
  const wide = await newSilentContext(browser, {
    viewport: { width: 1280, height: 900 },
    colorScheme: scheme,
    storageState: await ctx.storageState(),
  });
  const desk = await wide.newPage();
  await desk.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  check(
    await desk.locator('nav a[href="/today"], aside a[href="/today"]').first().isVisible(),
    `${scheme}: the rail links to it too`,
  );
  await wide.close();

  check(
    errs.length === 0,
    `${scheme}: no page errors${errs.length ? `: ${errs.join(" | ")}` : ""}`,
  );
  await ctx.close();
}

try {
  await pass("light");
  await pass("dark");
} catch (e) {
  console.log(`✗ ${e.message}`);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
