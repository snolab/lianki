// /dev/costs QA (docs/payments.md, "Cost ledger"): silent, phone and desktop,
// light and dark. Against a local `wrangler dev` on LOCAL D1 only: it refuses
// any other host, and every row it writes is in the local database (removed at
// the end).
//
//   QA_BASE=http://localhost:<port> bun scripts/qa/qa-costs.mjs [outDir]
//
// Proves: a non-admin gets a plain 404 (page and API); a speech-server
// utterance reported by a page is booked to that account (204, then a row);
// the admin sees totals, features and the account by display name — never its
// email — with no sideways scroll at 360 px.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/costs";
if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname))
  throw new Error(`qa-costs writes cost rows: local servers only, not ${BASE}`);
mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const ADMIN = `qa+costs-${stamp}@lianki.test`;
const PLAIN = `qa+costs-plain-${stamp}@lianki.test`;
const PLAIN_NAME = `QA Costs ${stamp}`;
const PW = "qa-test-pass-1234";

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const d1 = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--json", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local d1: ${r.stderr}`);
  try {
    return JSON.parse(r.stdout)[0]?.results ?? [];
  } catch {
    return [];
  }
};
const PLAIN_ID = `(SELECT id FROM user WHERE email = '${PLAIN}')`;

const browser = await launchSilent(chromium, { channel: "chromium" });

const VIEWS = [
  ["small", { ...devices["iPhone SE"], viewport: { width: 360, height: 640 } }],
  ["phone", { ...devices["iPhone 13"] }],
  ["desktop", { viewport: { width: 1280, height: 800 } }],
];

async function signUp(email, name = "QA") {
  const ctx = await newSilentContext(browser, {});
  const r = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email, password: PW, name },
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

/** The permission snapshot refreshes within ~20 s of the grant: reload until the page shows. */
async function openPage(page) {
  for (let i = 0; i < 12; i++) {
    await page.goto(`${BASE}/dev/costs`);
    const ready = await page
      .getByTestId("costs-totals")
      .waitFor({ timeout: budget(10_000) })
      .then(() => true)
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

async function run(name, device, colorScheme) {
  const tag = `${name}-${colorScheme}`;
  const { ctx, page, ok } = await signedIn(ADMIN, device, colorScheme);
  check(ok, `${tag}: signed in as the local admin`);
  if (!(await openPage(page))) {
    check(false, `${tag}: /dev/costs shows its totals`);
    await ctx.close();
    return;
  }
  const user = page.getByTestId("costs-user").filter({ hasText: PLAIN_NAME });
  check(
    await user
      .first()
      .waitFor({ timeout: budget(10_000) })
      .then(() => true)
      .catch(() => false),
    `${tag}: the account is listed by its display name`,
  );
  const features = (await page.getByTestId("costs-features").textContent()) ?? "";
  check(
    features.includes("speech.stt.local") && features.includes("words.tts"),
    `${tag}: by feature lists the booked features`,
  );
  check(!(await page.content()).includes(PLAIN), `${tag}: no email on the page`);
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${tag}: no sideways scroll`,
  );
  await page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
  await ctx.close();
}

try {
  check(await signUp(ADMIN), "the admin QA account signs up");
  check(await signUp(PLAIN, PLAIN_NAME), "a plain QA account signs up");
  d1(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${ADMIN}', 'admin', 'qa', ${Date.now()})`,
  );

  // Not an admin: a plain 404, page and API.
  const plain = await signedIn(PLAIN);
  check(plain.ok, "signed in as a plain account");
  check(
    (await plain.page.request.get(`${BASE}/dev/costs`)).status() === 404,
    "a non-admin gets 404 on /dev/costs",
  );
  check(
    (await plain.page.request.get(`${BASE}/api/dev/costs`)).status() === 404,
    "and on /api/dev/costs",
  );
  // The page's report of a speech-server utterance: booked to this account.
  const report = await plain.page.request.post(`${BASE}/api/debug/stt/local`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { audioMs: 12_000 },
  });
  check(report.status() === 204, "a speech-server utterance is accepted (204)");
  const cross = await plain.page.request.post(`${BASE}/api/debug/stt/local`, {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { audioMs: 12_000 },
  });
  check(cross.status() === 403, "another site cannot book for the account (403)");
  await plain.ctx.close();
  const booked = d1(
    `SELECT feature, units FROM cost_ledger WHERE user_id = ${PLAIN_ID} AND feature = 'speech.stt.local'`,
  );
  check(booked.length === 1 && booked[0].units === 12, "booked once, 12 audio seconds");
  // A free read-aloud call as the route books it (a real one needs Workers AI).
  const now = new Date();
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  d1(
    `INSERT INTO cost_ledger (user_id, feature, usd_micro, units, day, at) VALUES (${PLAIN_ID}, 'words.tts', 2.5, 12, '${day}', '${now.toISOString()}')`,
  );

  for (const [name, device] of VIEWS) {
    await run(name, device, "light");
    await run(name, device, "dark");
  }
} finally {
  d1(`DELETE FROM cost_ledger WHERE user_id = ${PLAIN_ID}`);
  d1(`DELETE FROM account_permission WHERE email = '${ADMIN}'`);
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
