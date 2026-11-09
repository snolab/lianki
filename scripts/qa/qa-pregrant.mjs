// Pre-grants on /dev/users (docs/payments.md, "Pre-grants";
// lib/referrals/pregrant.ts). Silent; 360 px, light and dark screenshots.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-pregrant.mjs [outDir]
//
// In qa:all (suite pregrant), or against any local server on local D1. A
// throwaway account is granted `admin` in the LOCAL account_permission (as
// qa-flags does) and every row this run made is deleted at the end. Fake
// addresses at lianki.test only.
//
// - a non-admin gets 404 from /api/dev/pregrants;
// - the panel: paste a list → Preview shows ok / invalid / duplicate /
//   has-an-account → Apply → the summary, and a "pending" row in the users
//   table; no sideways scroll at 360 px;
// - Revoke on that row (confirm) → the row is gone;
// - the claim: a pending address signs up with an UNVERIFIED email → no Pro;
//   verified (set in local D1) and signed in again → Pro, row claimed.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/pregrant";
const PW = "qa-test-pass-1234";
const RUN = Date.now();
const ADMIN = `qa+pgadmin${RUN}@lianki.test`;
const TAKEN = `qa+pgtaken${RUN}@lianki.test`;
const NEW1 = `qa+pgnew${RUN}@lianki.test`;
const NEW2 = `qa+pgnext${RUN}@lianki.test`;
const CLAIM = `qa+pgclaim${RUN}@lianki.test`;
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const d1 = (command, json = false) => {
  const r = spawnSync(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "lianki",
      "--local",
      ...(json ? ["--json"] : []),
      "--command",
      command,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local D1: ${r.stderr}`);
  return json ? (JSON.parse(r.stdout)[0]?.results ?? []) : null;
};

async function newCtx(browser, scheme = "light") {
  return newSilentContext(browser, {
    baseURL: BASE,
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
}

async function signUp(ctx, email) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Pregrant" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${email.split("@")[0]} (${r.status()})`);
}
async function signIn(ctx, email) {
  const r = await ctx.request.post("/api/auth/sign-in/email", {
    data: { email, password: PW },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-in ${email.split("@")[0]} (${r.status()})`);
}

/** The permission snapshot refreshes within ~20 s: wait for the panel, reloading. */
async function openPanel(page) {
  for (let i = 0; i < 12; i++) {
    await page.goto("/dev/users");
    if (await page.locator("[data-pregrant]").count()) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const browser = await launchSilent(chromium);
try {
  // A plain account: 404, and an existing account for the preview.
  {
    const ctx = await newCtx(browser);
    await signUp(ctx, TAKEN);
    const r = await ctx.request.get("/api/dev/pregrants");
    check(r.status() === 404, `non-admin GET /api/dev/pregrants is 404 (${r.status()})`);
    await ctx.close();
  }

  const signup = await newCtx(browser);
  await signUp(signup, ADMIN);
  await signup.close();
  d1(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${ADMIN}', 'admin', 'qa', ${Date.now()})`,
  );

  for (const scheme of ["light", "dark"]) {
    const tag = scheme;
    const ctx = await newCtx(browser, scheme);
    await signIn(ctx, ADMIN);
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    check(await openPanel(page), `${tag}: the pre-grant panel shows for an admin`);
    const mine = scheme === "light" ? NEW1 : NEW2;
    await page
      .locator("[data-pregrant-list]")
      .fill([`${mine},45,qa run`, "not-an-address", mine, TAKEN].join("\n"));
    await page.locator("[data-pregrant-days]").fill("30");
    await page.locator("[data-pregrant-preview]").click();
    await page.waitForSelector("[data-pregrant-rows] li");
    const statuses = await page
      .locator("[data-pregrant-rows] li")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    check(
      JSON.stringify(statuses) === JSON.stringify(["ok", "invalid", "duplicate", "account"]),
      `${tag}: preview classifies ok / invalid / duplicate / account (${statuses.join(",")})`,
    );
    check(
      (await page
        .locator('[data-status="account"] [data-choice="skip"][aria-pressed="true"]')
        .count()) === 1,
      `${tag}: an existing account is skipped by default`,
    );
    check(await noSideScroll(page), `${tag}: no sideways scroll at 360 px (preview)`);
    await page.screenshot({ path: join(OUT, `${tag}-preview.png`), fullPage: true });

    await page.locator("[data-pregrant-apply]").click();
    await page.waitForSelector("[data-pregrant-done]");
    const pendingRow = page.locator(`tr[data-pending="${mine}"]`);
    await pendingRow.waitFor({ timeout: 15_000 });
    check(true, `${tag}: applied; the address shows as a pending row`);
    const res = await (await ctx.request.get("/api/dev/pregrants")).json();
    const row = res.pending.find((p) => p.email === mine);
    check(row?.days === 45 && row?.note === "qa run", `${tag}: CSV days and note were kept`);
    const takenPro = d1(`SELECT proEndsAt FROM user WHERE email = '${TAKEN}'`, true)[0];
    check(takenPro && !takenPro.proEndsAt, `${tag}: the skipped existing account got nothing`);
    check(await noSideScroll(page), `${tag}: no sideways scroll at 360 px (table)`);
    await pendingRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, `${tag}-pending.png`), fullPage: true });

    await pendingRow.locator("[data-revoke]").click();
    await page.waitForFunction((m) => !document.querySelector(`tr[data-pending="${m}"]`), mine, {
      timeout: 15_000,
    });
    check(true, `${tag}: revoke removes the pending row`);
    const after = await (await ctx.request.get("/api/dev/pregrants")).json();
    check(!after.pending.some((p) => p.email === mine), `${tag}: and the API no longer lists it`);
    await ctx.close();
  }

  // The claim: unverified never; verified at the next sign-in.
  {
    const admin = await newCtx(browser);
    await signIn(admin, ADMIN);
    const r = await admin.request.post("/api/dev/pregrants", {
      data: { action: "apply", text: `${CLAIM},12`, days: 30, key: `qa-${RUN}` },
      headers: { origin: BASE },
    });
    check(r.ok() && (await r.json()).created === 1, "a pre-grant for the claim test");
    await admin.close();

    const ctx = await newCtx(browser);
    await signUp(ctx, CLAIM);
    const pro = () => d1(`SELECT proEndsAt FROM user WHERE email = '${CLAIM}'`, true)[0]?.proEndsAt;
    check(!pro(), "an unverified address claims nothing");
    d1(`UPDATE user SET emailVerified = 1 WHERE email = '${CLAIM}'`);
    const again = await newCtx(browser);
    await signIn(again, CLAIM);
    const until = pro();
    const days = until ? (Date.parse(until) - Date.now()) / 864e5 : 0;
    check(
      days > 11.9 && days < 12.1,
      `verified, the next sign-in claims 12 days (${days.toFixed(2)})`,
    );
    const claimed = d1(
      `SELECT claimed_at FROM pending_membership WHERE email = '${CLAIM}'`,
      true,
    )[0];
    check(Boolean(claimed?.claimed_at), "the row is stamped claimed");
    await ctx.close();
    await again.close();
  }
} finally {
  d1(`DELETE FROM account_permission WHERE email = '${ADMIN}'`);
  d1(`DELETE FROM pending_membership WHERE email LIKE 'qa+pg%${RUN}@lianki.test'`);
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
