// The menu's Sign out, on Chromium and WebKit (the owner's iPhone PWA is WebKit):
// sign in with a throwaway dev password account, open the profile menu, press
// Sign out, and check the session cookie is gone, the server has no session,
// the page was hard-navigated off the app, and a signed-in page now sends the
// browser to /sign-in. lib/sign-out.ts; owner, 2026-11-05 ("登出按钮好像用不了").
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-sign-out.mjs
import { chromium, webkit } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const PW = "qa-test-pass-1234";
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const email = `qa+signout-${name}-${Date.now()}@lianki.test`;
  const browser = await launchSilent(type);
  const ctx = await newSilentContext(browser, { viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const sessionCookie = async () =>
    (await ctx.cookies()).find((c) => c.name.endsWith("better-auth.session_token"));
  const getSession = () =>
    page.evaluate(async () => {
      const r = await fetch("/api/auth/get-session");
      return r.ok ? await r.json() : null;
    });
  // Navigate with "commit" and wait for what the step needs, never
  // "networkidle": WebKit under load hung 40 s on it going to /my/profile
  // (local stress run, 2026-11-10; docs/shipping.md, "Two WebKit traps").
  const go = (path) => page.goto(`${BASE}${path}`, { waitUntil: "commit" });
  // The menu needs hydration before a click opens it: click until it does.
  const openMenu = async () => {
    const until = Date.now() + budget(20000);
    while (!(await page.locator("[data-sign-out]").isVisible())) {
      if (Date.now() > until) throw new Error("the profile menu never opened");
      await page
        .locator("[data-profile-menu]")
        .click({ timeout: budget(10000) })
        .catch(() => {});
      await page.waitForTimeout(300);
    }
  };
  try {
    await go("/sign-in");
    // Before hydration, Continue does nothing the test can see (or reloads the
    // form): fill and press it again until the password step shows.
    for (const until = Date.now() + budget(30000); ; ) {
      await page.locator("#email").fill(email);
      await page.getByRole("button", { name: "Continue" }).click();
      const shown = await page
        .locator("#password")
        .waitFor({ timeout: budget(3000) })
        .then(() => true)
        .catch(() => false);
      if (shown) break;
      if (Date.now() > until) throw new Error("the password step never showed");
    }
    await page.locator("#password").fill(PW);
    await page.getByRole("button", { name: /sign in/i }).click();
    const notNow = page.getByRole("button", { name: "Not now" });
    await Promise.race([
      page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: budget(30000) }),
      notNow.waitFor({ timeout: budget(30000) }).then(() => notNow.click()),
    ]);
    await page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: budget(30000) });
    check((await getSession())?.user?.email === email, `${name}: signed in`);
    check(Boolean(await sessionCookie()), `${name}: session cookie set`);

    await go("/my/profile");
    // The user's own AI key (docs/byok.md) must not outlive the session here.
    await page.evaluate(() => localStorage.setItem("lk:byok", '{"v":1,"apiKey":"qa-not-a-key"}'));
    await openMenu();
    const button = page.locator("[data-sign-out]");
    await Promise.all([
      page.waitForURL((u) => !/\/my\/profile/.test(u.pathname), { timeout: budget(30000) }),
      button.click(),
    ]);
    // The cookie goes with the sign-out request; give it the budget, not a fixed wait.
    for (const until = Date.now() + budget(10000); (await sessionCookie()) && Date.now() < until; )
      await page.waitForTimeout(200);
    check(!(await sessionCookie()), `${name}: session cookie cleared`);
    check(!(await getSession())?.user, `${name}: server has no session`);
    check(
      (await page.evaluate(() => localStorage.getItem("lk:byok"))) === null,
      `${name}: the BYOK key is gone from this device`,
    );
    check(new URL(page.url()).pathname !== "/my/profile", `${name}: left the page (${page.url()})`);
    // The service worker caches every page it serves; the signed-in ones must be gone
    // (it may already have cached the signed-out landing page again).
    const cached = await page.evaluate(async () => {
      if (!("caches" in self)) return [];
      const hits = await Promise.all(
        ["/my/profile", "/home", "/list"].map(async (p) => ((await caches.match(p)) ? p : null)),
      );
      return hits.filter(Boolean);
    });
    check(cached.length === 0, `${name}: no signed-in page cached (${cached.join(",") || "none"})`);

    // Signed out, /my/profile sends to /sign-in — or, with the `levels` flag on
    // (docs/levels.md), shows only the guest level card: no account on it.
    await go("/my/profile");
    await page
      .waitForFunction(
        () =>
          location.pathname.startsWith("/sign-in") ||
          !!document.querySelector("[data-level-card] [data-level-progress]"),
        null,
        { timeout: budget(30000) },
      )
      .catch(() => {});
    const guestCard =
      (await page.locator('[data-level-card] [data-level-progress][href="/sign-in"]').count()) >
        0 && !(await page.content()).includes("@lianki.test");
    check(
      /\/sign-in/.test(page.url()) || guestCard,
      `${name}: /my/profile is signed out (${page.url()}${guestCard ? ", guest level card" : ""})`,
    );

    const legacy = await page.goto(`${BASE}/auth/logout`, { waitUntil: "domcontentloaded" });
    check(
      legacy?.status() !== 404 && !/\/en\/auth/.test(page.url()),
      `${name}: /auth/logout is no 404 (${legacy?.status()} ${page.url()})`,
    );
  } catch (e) {
    check(false, `${name}: ${e.message.split("\n")[0]} at ${page.url()}`);
  } finally {
    await browser.close();
  }
}

console.log(ok ? "\nsign-out: all checks passed" : "\nsign-out: FAILED");
process.exit(ok ? 0 : 1);
