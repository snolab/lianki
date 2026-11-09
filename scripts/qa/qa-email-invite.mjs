// Invite by email on /membership (docs/payments.md, "Invite by email"). Silent;
// iPhone size, light and dark screenshots. The provider is stubbed: a server on
// localhost never mails anyone (lib/referrals/email-invite-deps.ts), and every
// address here is a fake one at lianki.test.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-email-invite.mjs [outDir]
//
// In qa:all (suite email-invite), or against any local server on local D1: it
// turns `membership.email-invite` on in the local D1 and deletes the row at the end.
//
// - a trial account (not Pro): no box, and the route answers 404;
// - Pro: the box shows; two addresses at once is refused; one address gives the
//   neutral "Done" and a masked line in "Sent by you"; the log row is 'sent'
//   through the stub; the remaining count drops;
// - the opt-out page with no token says the link is not valid; a forged
//   one-click token is refused.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/email-invite";
const PW = "qa-test-pass-1234";
const FLAG = "membership.email-invite";
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
const setFlag = (on) =>
  d1(
    on
      ? `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${FLAG}', 1, '2026-11-09T00:00:00.000Z', 'qa')`
      : `DELETE FROM feature_flags WHERE key = '${FLAG}'`,
  );
const makePro = (email) =>
  d1(
    `UPDATE user SET proEndsAt = '${new Date(Date.now() + 30 * 864e5).toISOString()}' WHERE email = '${email}'`,
  );

async function signUp(ctx, tag) {
  const email = `qa+ei${tag}${Date.now()}@lianki.test`;
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Inviter" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up (${r.status()})`);
  return email;
}
const status = async (ctx) => (await ctx.request.get("/api/invite/email")).json();

const browser = await launchSilent(chromium);
try {
  setFlag(true);
  {
    const ctx = await newSilentContext(browser, { baseURL: BASE });
    await signUp(ctx, "trial");
    // The flag reaches the server within 30 s (docs/feature-flags.md); a trial
    // account stays out either way.
    const s = await status(ctx);
    check(s.allowed === false, "trial account: not allowed");
    const r = await ctx.request.post("/api/invite/email", {
      data: { email: "qa-nobody@lianki.test" },
      headers: { origin: BASE, "content-type": "application/json" },
    });
    check(r.status() === 404, `trial account: POST is 404 (${r.status()})`);
    const page = await ctx.newPage();
    await page.goto("/membership?lang=en");
    await page.waitForTimeout(1500);
    check((await page.locator('[data-qa="email-invite"]').count()) === 0, "trial account: no box");
    await ctx.close();
  }

  for (const scheme of ["light", "dark"]) {
    console.log(`— iPhone 13 ${scheme}`);
    const ctx = await newSilentContext(browser, {
      ...devices["iPhone 13"],
      baseURL: BASE,
      colorScheme: scheme,
    });
    const me = await signUp(ctx, scheme);
    makePro(me);
    for (let i = 0; i < 25 && !(await status(ctx)).allowed; i++)
      await new Promise((r) => setTimeout(r, 2000));
    const before = await status(ctx);
    check(before.allowed === true && before.remaining === before.limit, "Pro: allowed, full quota");

    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto("/membership?lang=en");
    const box = page.locator('[data-qa="email-invite"]');
    await box.waitFor({ timeout: 30000 });
    const input = page.locator('[data-qa="email-invite-input"]');
    const send = page.locator('[data-qa="email-invite-send"]');
    const msg = page.locator('[data-qa="email-invite-msg"]');

    // Two at once: refused by the server, shown in our own words.
    await input.fill("qa-a@lianki.test; qa-b@lianki.test");
    await send.click();
    await msg.waitFor({ timeout: 10000 });
    check(
      /one email address/i.test(await msg.innerText()),
      "two addresses: 'Enter one email address'",
    );

    const friend = `qa-friend-${scheme}-${Date.now()}@lianki.test`;
    await input.fill(friend);
    await send.click();
    await page.waitForFunction(
      () =>
        /Done\./.test(document.querySelector('[data-qa="email-invite-msg"]')?.textContent ?? ""),
      null,
      { timeout: 15000 },
    );
    check(true, "one address: the neutral 'Done'");
    const hist = page.locator('[data-qa="email-invite-history"]');
    await hist.waitFor({ timeout: 10000 });
    const histText = await hist.innerText();
    check(/q\*\*\*@lianki\.test/.test(histText), "history shows the masked address");
    check(!histText.includes(friend), "history never shows the full address");
    check(
      /Left today: 4 of 5/.test(
        await page.locator('[data-qa="email-invite-remaining"]').innerText(),
      ),
      "remaining dropped to 4 of 5",
    );
    const log = d1(
      "SELECT l.status, l.providerId, l.recipientMasked FROM invite_email_log l JOIN user u ON u.id = l.inviterId WHERE u.email = '" +
        me +
        "'",
      true,
    );
    check(
      log.length === 1 && log[0].status === "sent" && String(log[0].providerId).startsWith("stub-"),
      `log row: sent through the stub (${log[0]?.status}/${String(log[0]?.providerId).slice(0, 5)})`,
    );
    const box360 = await box.boundingBox();
    check(box360 && box360.width <= 390, "fits the phone width");
    await box.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, `membership-${scheme}.png`), fullPage: true });

    // The opt-out page: no token → not valid; a forged one-click → 400.
    await page.goto("/membership/invite-opt-out?lang=en");
    await page.locator('[data-qa="opt-out-invalid"]').waitFor({ timeout: 15000 });
    check(true, "opt-out page without a token: not valid");
    await page.goto(
      `/membership/invite-opt-out?lang=en#t=${crypto.randomUUID()}.${"A".repeat(43)}`,
    );
    await page.locator('[data-qa="opt-out-unsubscribe"]').waitFor({ timeout: 15000 });
    await page.screenshot({ path: join(OUT, `opt-out-${scheme}.png`), fullPage: true });
    await page.locator('[data-qa="opt-out-unsubscribe"]').click();
    await page.locator('[data-qa="opt-out-invalid"]').waitFor({ timeout: 15000 });
    check(true, "opt-out page with a forged token: not valid");
    const forged = await ctx.request.post(
      `/api/invite/email/opt-out?t=${crypto.randomUUID()}.${"A".repeat(43)}`,
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        data: "List-Unsubscribe=One-Click",
      },
    );
    check(forged.status() === 400, `one-click with a forged token: 400 (${forged.status()})`);
    check(errs.length === 0, `no page errors (${errs.join(" | ")})`);
    await ctx.close();
  }
} finally {
  setFlag(false);
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall email-invite checks passed");
process.exit(failed ? 1 : 0);
