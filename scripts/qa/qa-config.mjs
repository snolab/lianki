// /dev/config QA (docs/config-store.md): silent, phone and desktop, light and
// dark. Against a local `wrangler dev` on LOCAL D1 only: it refuses any other
// host, and every value it changes is in the local database (removed at the end).
//
//   QA_BASE=http://localhost:<port> bun scripts/qa/qa-config.mjs [outDir]
//
// Proves the path end to end: a value saved on the page reaches the next
// rendered page (the public bundle the app layout hands to the browser), a
// reset brings the default back, an invalid value is refused, and a non-admin
// gets a plain 404.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/config";
if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname))
  throw new Error(`qa-config changes config values: local servers only, not ${BASE}`);
mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const ADMIN = `qa+config-${stamp}@lianki.test`;
const PLAIN = `qa+config-plain-${stamp}@lianki.test`;
const PW = "qa-test-pass-1234";
const KEY = "words.undoMs";

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const sql = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local d1: ${r.stderr}`);
};

const browser = await launchSilent(chromium, { channel: "chromium" });

const VIEWS = [
  ["phone", { ...devices["iPhone 13"] }],
  ["small", { ...devices["iPhone SE"], viewport: { width: 360, height: 640 } }],
  ["desktop", { viewport: { width: 1280, height: 800 } }],
];

async function signUp(email) {
  const ctx = await newSilentContext(browser, {});
  const r = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email, password: PW, name: "QA" },
  });
  await ctx.close();
  return r.ok();
}

async function signedIn(email, device = {}, colorScheme = "light") {
  const ctx = await newSilentContext(browser, { ...device, colorScheme });
  const page = await ctx.newPage();
  const r = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email, password: PW },
  });
  return { ctx, page, ok: r.ok() };
}

/** The public value of KEY in a rendered app page's flight data. */
async function renderedUndoMs(page) {
  const html = await (await page.request.get(`${BASE}/words`)).text();
  const m = /words\.undoMs\\?"\s*:\s*(\d+)/.exec(html);
  return m ? Number(m[1]) : null;
}

/**
 * The permission snapshot refreshes within ~20 s of the grant (lib/permissions.ts):
 * until then the page is a 404, so reload until the list shows.
 */
async function openPage(page) {
  for (let i = 0; i < 12; i++) {
    await page.goto(`${BASE}/dev/config`);
    const ready = await page
      .locator("[data-config-group]")
      .first()
      .waitFor({ timeout: budget(10_000) })
      .then(() => true)
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

const row = (page) => page.locator(`[data-config-key="${KEY}"]`);

async function run(name, device, colorScheme) {
  const tag = `${name}-${colorScheme}`;
  const { ctx, page, ok } = await signedIn(ADMIN, device, colorScheme);
  check(ok, `${tag}: signed in as the local admin`);
  if (!(await openPage(page))) {
    check(false, `${tag}: /dev/config shows its list`);
    await ctx.close();
    return;
  }
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${tag}: no sideways scroll`,
  );
  check((await row(page).count()) === 1, `${tag}: ${KEY} has its row`);
  check(
    (await row(page).locator("[data-config-changed]").count()) === 0,
    `${tag}: at its default, no Changed badge`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-list.png`), fullPage: true });

  // Save a new value: toast, badge, history, and the next page renders it.
  const input = row(page).locator('input[type="number"]');
  await input.fill("9000");
  await row(page).locator('button[type="submit"]').click();
  await page.locator('[data-dev-toast="ok"]').waitFor({ timeout: budget(10_000) });
  check(true, `${tag}: saving shows the saved toast`);
  await row(page)
    .locator("[data-config-changed]")
    .waitFor({ timeout: budget(10_000) });
  check(true, `${tag}: the row is marked Changed`);
  check((await renderedUndoMs(page)) === 9000, `${tag}: /words renders the new value`);
  await row(page).locator("[data-config-history]").click();
  check(
    (await row(page).locator("li").first().innerText()).includes("9000"),
    `${tag}: the history lists the change`,
  );
  await page.screenshot({ path: join(OUT, `${tag}-changed.png`), fullPage: true });

  // An out-of-range value: the field refuses it in the browser, and the API
  // refuses it too (400) when sent anyway.
  await input.fill("1");
  check(
    await input.evaluate((el) => !el.validity.valid),
    `${tag}: the field marks an out-of-range value invalid`,
  );
  const refused = await page.request.post(`${BASE}/api/dev/config`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { key: KEY, value: 1 },
  });
  check(refused.status() === 400, `${tag}: the API refuses it (${refused.status()})`);
  check((await renderedUndoMs(page)) === 9000, `${tag}: and the live value is unchanged`);

  // Reset to the default.
  await row(page).locator("[data-config-reset]").click();
  await page.waitForFunction(
    (k) => !document.querySelector(`[data-config-key="${k}"] [data-config-changed]`),
    KEY,
    { timeout: budget(10_000) },
  );
  check(true, `${tag}: reset clears the Changed badge`);
  check((await renderedUndoMs(page)) === 8000, `${tag}: /words renders the default again`);
  await ctx.close();
}

try {
  check(await signUp(ADMIN), "the admin QA account signs up");
  check(await signUp(PLAIN), "a plain QA account signs up");
  const at = Date.now();
  sql(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${ADMIN}', 'admin', 'qa', ${at})`,
  );
  sql(`DELETE FROM config_values WHERE key = '${KEY}'`);

  // Not an admin: a plain 404, page and API.
  const plain = await signedIn(PLAIN);
  check(plain.ok, "signed in as a plain account");
  check(
    (await plain.page.request.get(`${BASE}/dev/config`)).status() === 404,
    "a non-admin gets 404 on /dev/config",
  );
  check(
    (await plain.page.request.get(`${BASE}/api/dev/config`)).status() === 404,
    "and on /api/dev/config",
  );
  await plain.ctx.close();

  for (const [name, device] of VIEWS) {
    await run(name, device, "light");
    await run(name, device, "dark");
  }
} finally {
  sql(`DELETE FROM config_values WHERE key = '${KEY}'`);
  sql(`DELETE FROM config_log WHERE by = '${ADMIN}'`);
  sql(`DELETE FROM account_permission WHERE email = '${ADMIN}'`);
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
