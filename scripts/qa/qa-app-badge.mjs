// The app-icon badge (docs/app-badge.md, lib/app-badge.ts). Silent; 360 px,
// light and dark screenshots of the setting.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-app-badge.mjs [outDir]
//
// In qa:all (suite app-badge), or against any local server on local D1: it
// turns `pwa.app-badge` on in the local D1 for the middle part and deletes the
// row at the end. The Badging API is mocked in the page (navigator.setAppBadge
// and clearAppBadge record their calls); nothing reaches the real icon.
//
// - flag off: no Notifications section, /api/badge answers {on: false}, and
//   the page only clears the badge;
// - flag on, an account without `dev`: the same, nothing (owner-only flag);
// - flag on, an account granted `dev` in the LOCAL account_permission (as
//   qa-flags does; removed at the end), with 2 due page cards and 1 open ask
//   card: the page sets 3; "Unanswered questions from Li" sets 1, persists across a reload
//   and reaches the account (/api/prefs); on /chat/history the asks count as
//   seen (badge 0 with that mode).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/app-badge";
const PW = "qa-test-pass-1234";
const FLAG = "pwa.app-badge";
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
const setFlag = (on) =>
  d1(
    on
      ? `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${FLAG}', 1, '2026-11-09T00:00:00.000Z', 'qa')`
      : `DELETE FROM feature_flags WHERE key = '${FLAG}'`,
  );

/** The Badging API, mocked: every call lands in window.__badge (a number, or "clear"). */
const MOCK = () => {
  window.__badge = [];
  try {
    localStorage.setItem("lk:first-run", "local");
  } catch {}
  Object.defineProperty(Navigator.prototype, "setAppBadge", {
    configurable: true,
    value(n) {
      window.__badge.push(n ?? 0);
      return Promise.resolve();
    },
  });
  Object.defineProperty(Navigator.prototype, "clearAppBadge", {
    configurable: true,
    value() {
      window.__badge.push("clear");
      return Promise.resolve();
    },
  });
};

async function newCtx(browser, scheme = "light") {
  const ctx = await newSilentContext(browser, {
    baseURL: BASE,
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  await ctx.addInitScript(MOCK);
  return ctx;
}

/** Local throwaway accounts granted `dev` by this run, removed at the end. */
const granted = [];
const grantDev = (email) => {
  granted.push(email);
  d1(
    `INSERT OR REPLACE INTO account_permission (email, permission, granted_by, granted_at) VALUES ('${email}', 'dev', 'qa', ${Date.now()})`,
  );
};

async function signUp(ctx, tag) {
  const email = `qa+badge${tag}${Date.now()}@lianki.test`;
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email, password: PW, name: "QA Badge" },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up (${r.status()})`);
  const me = await (await ctx.request.get("/api/prefs")).json();
  return { id: me.user, email };
}

const lastBadge = (page) => page.evaluate(() => window.__badge.at(-1));
const waitBadge = (page, want) =>
  page
    .waitForFunction((w) => window.__badge.at(-1) === w, want, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

const browser = await launchSilent(chromium);
try {
  setFlag(false);
  {
    const ctx = await newCtx(browser);
    await signUp(ctx, "off");
    const page = await ctx.newPage();
    await page.goto("/preferences?lang=en");
    await page.locator("h1").first().waitFor({ timeout: 30000 });
    check(
      (await page.getByTestId("app-badge").count()) === 0,
      "flag off: no Notifications section",
    );
    const j = await (await ctx.request.get("/api/badge")).json();
    check(j.on === false, "flag off: /api/badge answers {on: false}");
    await waitBadge(page, "clear");
    const calls = await page.evaluate(() => window.__badge);
    check(
      calls.every((c) => c === "clear"),
      `flag off: the page only clears the badge (${JSON.stringify(calls)})`,
    );
    await ctx.close();
  }

  setFlag(true);
  {
    // Owner-only: a signed-in account without `dev` still gets nothing.
    const ctx = await newCtx(browser);
    await signUp(ctx, "user");
    // The server caches flags for 30 s: wait until an owner would see it, then check this one.
    await new Promise((r) => setTimeout(r, 31000));
    const j = await (await ctx.request.get("/api/badge")).json();
    check(j.on === false, "flag on, not the owner: /api/badge answers {on: false}");
    const page = await ctx.newPage();
    await page.goto("/preferences?lang=en");
    await page.locator("h1").first().waitFor({ timeout: 30000 });
    check(
      (await page.getByTestId("app-badge").count()) === 0,
      "flag on, not the owner: no Notifications section",
    );
    await ctx.close();
  }
  for (const scheme of ["light", "dark"]) {
    console.log(`— 360 px ${scheme}`);
    const ctx = await newCtx(browser, scheme);
    const { id: userId, email } = await signUp(ctx, scheme);
    grantDev(email);
    // Two page cards, new and so due now, and one open ask card in this account's chat.
    // Added before the first /api/badge read: the server keeps counts 15 s per account.
    for (const n of [1, 2]) {
      const r = await ctx.request.post("/api/fsrs/add", {
        data: { url: `https://example.com/qa-badge-${scheme}-${n}`, title: `QA badge ${n}` },
        headers: { origin: BASE },
      });
      check(r.ok(), `card ${n} added (${r.status()})`);
    }
    d1(
      `INSERT INTO chat_line (user_id, id, thread, sender, text, at_ms, ask, answer) VALUES ('${userId}', 'qa-ask-${scheme}', 'owner', 'agent', 'QA?', ${Date.now()}, 1, NULL)`,
    );
    // Flags (30 s) and permission grants (20 s) are cached per isolate: wait for both to reach it.
    let counts = {};
    for (let i = 0; i < 25; i++) {
      counts = await (await ctx.request.get("/api/badge?mode=both")).json();
      if (counts.on === true) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    check(
      counts.on === true && counts.asks === 1 && counts.due === 2 && counts.count === 3,
      `/api/badge: 1 ask + 2 due = 3 (${JSON.stringify(counts)})`,
    );

    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto("/preferences?lang=en");
    const section = page.getByTestId("app-badge");
    await section.waitFor({ timeout: 30000 });
    check(
      await waitBadge(page, 3),
      `the page sets the badge to 3 (last: ${await lastBadge(page)})`,
    );
    const select = page.getByTestId("app-badge-mode");
    check((await select.inputValue()) === "both", "the setting starts at Both");
    const box = await section.boundingBox();
    check(!!box && box.x >= 0 && box.x + box.width <= 360, "the section fits 360 px");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, `setting-${scheme}.png`) });

    await select.selectOption("ask-cards");
    check(
      await waitBadge(page, 1),
      `"Unanswered questions" sets 1 (last: ${await lastBadge(page)})`,
    );
    let synced = false;
    for (let i = 0; i < 20 && !synced; i++) {
      const p = await (await ctx.request.get("/api/prefs")).json();
      synced = p.prefs?.["notify.badge"]?.value === "ask-cards";
      if (!synced) await new Promise((r) => setTimeout(r, 1000));
    }
    check(synced, "the setting reaches the account (notify.badge)");
    await page.reload();
    await select.waitFor({ timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="app-badge-mode"]')?.value === "ask-cards",
      null,
      { timeout: 10000 },
    );
    check((await select.inputValue()) === "ask-cards", "the setting persists across a reload");
    check(await waitBadge(page, 1), "after the reload the badge is 1 again");

    // The chat history shows the asks: they count as seen there.
    await page.goto("/chat/history?lang=en");
    check(await waitBadge(page, "clear"), "on /chat/history the asks count as seen (cleared)");
    check(errs.length === 0, `no page errors (${errs.join(" | ")})`);
    await ctx.close();
  }
} finally {
  try {
    setFlag(false);
    if (granted.length)
      d1(
        `DELETE FROM account_permission WHERE email IN (${granted.map((e) => `'${e}'`).join(", ")})`,
      );
  } catch (e) {
    console.error(e);
  }
  await browser.close();
}
console.log(failed ? `✗ ${failed} failed` : "✓ all passed");
process.exit(failed ? 1 : 0);
