// The send log at /dev/mails (docs/mail-templates.md, "Send log").
// Silent; phone (360) light + dark and desktop light, with screenshots.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-mails.mjs [outDir]
//
// In qa:all (suite mails), or against any local server on local D1. A
// throwaway account is granted `dev` in the LOCAL account_permission (as
// qa-templates does); the grant, the seeded rows and their suppression are
// removed at the end. Every send is the local stub: a server on localhost
// never mails. Fake addresses at lianki.test only.
//
// - a non-developer gets 404 from /api/dev/mails and /dev/mails;
// - a template test send goes through the real send path → a logged row;
// - search by address → the row; filter by status → the failed one;
// - a login notice: detail re-rendered from its kept variables; Resend behind a
//   confirmation → sent again (a second row);
// - a sign-in code: placeholders, Resend off with the reason; a masked old
//   invite: Resend off;
// - Suppress → badge; the suppression tab lists it; Remove → gone;
// - no sideways scroll at 360 px.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { recipientHash } from "../../lib/referrals/recipient-hash.ts";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/mails";
const PW = "qa-test-pass-1234";
const RUN = Date.now();
const DEV = `qa+maildev${RUN}@lianki.test`;
const PLAIN = `qa+mailplain${RUN}@lianki.test`;
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

const LAYOUTS = {
  phone: { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 900 } },
};
const newCtx = (browser, layout, scheme) =>
  newSilentContext(browser, {
    baseURL: BASE,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    ...LAYOUTS[layout],
  });

async function signUp(ctx, email) {
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Mails" },
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

/** The permission snapshot refreshes within ~20 s: wait for the page, reloading. */
async function openPage(page) {
  for (let i = 0; i < 12; i++) {
    await page.goto("/dev/mails");
    // The list's first answer: the page is hydrated (a search before that would
    // submit the form natively and reload it unfiltered).
    const ready = await page
      .locator("[data-testid=mails-total]")
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = Date.now();

/** Seed one pass's rows: a login notice with its variables, a sign-in code, a failed mail, a masked invite. */
async function seed(tag) {
  const notice = `qa+notice-${tag}-${RUN}@lianki.test`;
  const vars = JSON.stringify({
    time: "2027-01-15 12:00 JST",
    location: "Tokyo, JP",
    browser: "Firefox on Linux",
    contactUrl: "https://lianki.com/contact",
  });
  const row = (id, template, recipient, status, extra = {}) =>
    `(${q(id)}, ${now}, ${now}, ${q(template)}, ${extra.version ?? 0}, 'en', ${q(recipient)}, ${extra.masked ? 1 : 0}, ${q(extra.hash ?? "x")}, ${extra.vars ? q(extra.vars) : "NULL"}, ${q(status)}, ${extra.reason ? q(extra.reason) : "NULL"}, 're_qa_${tag}_${RUN}')`;
  d1(
    `INSERT INTO mail_log (id, created_at, updated_at, template, version, locale, recipient, recipient_masked, recipient_hash, vars, status, reason, provider_id) VALUES ` +
      [
        row(`qa-${RUN}-${tag}-n`, "login-notice", notice, "delivered", {
          vars,
          hash: await recipientHash(notice),
        }),
        row(`qa-${RUN}-${tag}-c`, "signin-code", notice, "sent"),
        row(`qa-${RUN}-${tag}-f`, "email-taken", notice, "failed", { reason: "qa refused" }),
        row(`qa-${RUN}-${tag}-m`, "invite", "q***@lianki.test", "sent", { masked: true }),
      ].join(", "),
  );
  return { notice, hash: await recipientHash(notice) };
}

const PASSES = [
  { layout: "phone", scheme: "light" },
  { layout: "phone", scheme: "dark" },
  { layout: "desktop", scheme: "light" },
];
const hashes = [];

const browser = await launchSilent(chromium);
try {
  {
    const ctx = await newCtx(browser, "phone", "light");
    await signUp(ctx, PLAIN);
    const r = await ctx.request.get("/api/dev/mails");
    check(r.status() === 404, `non-developer GET /api/dev/mails is 404 (${r.status()})`);
    const p = await (await ctx.newPage()).goto("/dev/mails");
    check(p?.status() === 404, `non-developer /dev/mails is 404 (${p?.status()})`);
    await ctx.close();
  }

  const signup = await newCtx(browser, "phone", "light");
  await signUp(signup, DEV);
  await signup.close();
  d1(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES (${q(DEV)}, 'dev', 'qa', ${Date.now()})`,
  );

  for (const p of PASSES) {
    const tag = `${p.layout}-${p.scheme}`;
    const { notice, hash } = await seed(tag);
    hashes.push(hash);
    const ctx = await newCtx(browser, p.layout, p.scheme);
    await signIn(ctx, DEV);
    const page = await ctx.newPage();
    check(await openPage(page), `${tag}: the page shows for a developer`);

    if (p === PASSES[0]) {
      // The real send path: a template test send (stub on localhost) is logged.
      const t = await ctx.request.post("/api/dev/templates", {
        data: {
          op: "test",
          id: "email-taken",
          locale: "en",
          sample: "typical",
          subject: "QA {brand}",
          html: "<p>QA</p>",
          text: "QA",
        },
        headers: { origin: BASE },
      });
      check(t.ok(), `${tag}: template test send (${t.status()})`);
      await page.locator("[data-testid=mails-q]").fill(DEV);
      await page.locator("[data-testid=mails-search]").click();
      // The list before the search is still on screen at first: wait for the answer.
      const found = await page
        .waitForFunction(
          (addr) => {
            const rows = [...document.querySelectorAll("[data-testid=mails-row]")];
            return rows.length > 0 && rows.every((r) => r.textContent?.includes(addr));
          },
          DEV,
          { timeout: 10_000 },
        )
        .then(() => true)
        .catch(() => false);
      check(found, `${tag}: the test send is in the log through the send path`);
    }

    // Search by address: this pass's three rows.
    await page.locator("[data-testid=mails-q]").fill(notice);
    await page.locator("[data-testid=mails-search]").click();
    await page.waitForFunction(
      (addr) => {
        const rows = [...document.querySelectorAll("[data-testid=mails-row]")];
        return rows.length === 3 && rows.every((r) => r.textContent?.includes(addr));
      },
      notice,
      { timeout: 10_000 },
    );
    check(true, `${tag}: search by address finds its 3 mails`);
    check(
      (await page.locator("[data-testid=mails-per-day]").count()) === 1,
      `${tag}: per-day counts show`,
    );
    await page.locator("[data-testid=mails-f-status]").selectOption("failed");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=mails-row]").length === 1,
      null,
      { timeout: 10_000 },
    );
    check(true, `${tag}: the status filter keeps the failed one`);
    await page.locator("[data-testid=mails-f-status]").selectOption("");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=mails-row]").length === 3,
    );
    check(await noSideScroll(page), `${tag}: no sideways scroll (list)`);
    await page.screenshot({ path: join(OUT, `${tag}-list.png`), fullPage: true });

    // The login notice: re-rendered, then Resend behind a confirmation.
    await page.locator(`[data-testid=mails-row][data-id="qa-${RUN}-${tag}-n"]`).click();
    await page.locator("[data-testid=mails-d-subject]").waitFor();
    const frame = await page.locator("[data-testid=mails-detail] iframe").elementHandle();
    const body = await (
      await frame.contentFrame()
    )
      ?.locator("body")
      .innerText()
      .catch(() => "");
    check((body ?? "").includes("Tokyo"), `${tag}: the notice is re-rendered from its variables`);
    await page.screenshot({ path: join(OUT, `${tag}-detail.png`), fullPage: false });
    await page.locator("[data-testid=mails-resend]").click();
    await page.locator("[data-testid=mails-confirm]").waitFor();
    check(
      (await page.locator("[data-testid=mails-confirm]").innerText()).includes(notice),
      `${tag}: the confirmation names the address`,
    );
    await page.locator("[data-testid=mails-confirm-yes]").click();
    await page.locator("[data-testid=mails-d-msg]").waitFor({ timeout: 10_000 });
    const okMsg = await page.locator("[data-testid=mails-d-msg]").getAttribute("class");
    check(okMsg?.includes("150"), `${tag}: Resend answers sent`);

    // Suppress → badge.
    await page.locator("[data-testid=mails-suppress]").click();
    await page.locator("[data-testid=mails-confirm-yes]").click();
    await page.locator("[data-testid=mails-d-suppressed]").waitFor({ timeout: 10_000 });
    check(true, `${tag}: Suppress shows the badge`);
    await page.locator("[data-testid=mails-close]").click();
    await page.locator("[data-testid=mails-search]").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=mails-row]").length === 4,
      null,
      { timeout: 10_000 },
    );
    check(true, `${tag}: the resend is a new row`);

    // The sign-in code: placeholders, no Resend.
    await page.locator(`[data-testid=mails-row][data-id="qa-${RUN}-${tag}-c"]`).click();
    await page.locator("[data-testid=mails-placeholders]").waitFor();
    check(
      await page.locator("[data-testid=mails-resend]").isDisabled(),
      `${tag}: a sign-in code cannot be re-sent`,
    );
    check(
      (await page.locator("[data-testid=mails-refusal]").count()) === 1,
      `${tag}: the reason is shown`,
    );
    await page.locator("[data-testid=mails-close]").click();

    // The masked old invite: no Resend.
    await page.locator("[data-testid=mails-q]").fill(`qa-${RUN}-${tag}-m`);
    await page.locator("[data-testid=mails-search]").click();
    await page.locator(`[data-testid=mails-row][data-id="qa-${RUN}-${tag}-m"]`).click();
    await page.locator("[data-testid=mails-d-recipient]").waitFor();
    check(
      await page.locator("[data-testid=mails-resend]").isDisabled(),
      `${tag}: a masked invite cannot be re-sent`,
    );
    await page.locator("[data-testid=mails-close]").click();

    // Suppression tab → remove.
    await page.locator("[data-testid=mails-tab-suppression]").click();
    const mine = page.locator("[data-testid=supp-row]", { hasText: notice });
    await mine.waitFor({ timeout: 10_000 });
    check(true, `${tag}: the suppressed address is listed`);
    check(await noSideScroll(page), `${tag}: no sideways scroll (suppression)`);
    await page.screenshot({ path: join(OUT, `${tag}-suppression.png`), fullPage: true });
    await mine.locator("[data-testid=supp-remove]").click();
    await page.locator("[data-testid=mails-confirm-yes]").click();
    await page.waitForFunction(
      (addr) =>
        ![...document.querySelectorAll("[data-testid=supp-row]")].some((e) =>
          e.textContent?.includes(addr),
        ),
      notice,
      { timeout: 10_000 },
    );
    check(true, `${tag}: Remove takes it off the list`);
    await ctx.close();
  }
} finally {
  try {
    d1(`DELETE FROM account_permission WHERE email = ${q(DEV)}`);
    d1(`DELETE FROM mail_log WHERE id LIKE 'qa-${RUN}-%' OR recipient LIKE '%${RUN}@lianki.test'`);
    for (const h of hashes)
      d1(`DELETE FROM invite_email_suppression WHERE recipientHash = ${q(h)}`);
  } catch (e) {
    console.log(`cleanup: ${e.message}`);
  }
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
