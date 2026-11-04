// The menu's Sign out, on Chromium and WebKit (the owner's iPhone PWA is WebKit):
// sign in with a throwaway dev password account, open the profile menu, press
// Sign out, and check the session cookie is gone, the server has no session,
// the page was hard-navigated off the app, and a signed-in page now sends the
// browser to /sign-in. lib/sign-out.ts; owner, 2026-11-05 ("登出按钮好像用不了").
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-sign-out.mjs
import { chromium, webkit } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

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
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator("#password").fill(PW);
    await page.getByRole("button", { name: /sign in/i }).click();
    const notNow = page.getByRole("button", { name: "Not now" });
    await Promise.race([
      page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: 30000 }),
      notNow.waitFor({ timeout: 30000 }).then(() => notNow.click()),
    ]);
    await page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: 30000 });
    check((await getSession())?.user?.email === email, `${name}: signed in`);
    check(Boolean(await sessionCookie()), `${name}: session cookie set`);

    await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
    await page.locator("[data-profile-menu]").click();
    const button = page.locator("[data-sign-out]");
    await button.waitFor({ timeout: 10000 });
    await Promise.all([
      page.waitForURL((u) => !/\/profile/.test(u.pathname), { timeout: 30000 }),
      button.click(),
    ]);
    await page.waitForLoadState("networkidle").catch(() => {});
    check(!(await sessionCookie()), `${name}: session cookie cleared`);
    check(!(await getSession())?.user, `${name}: server has no session`);
    check(new URL(page.url()).pathname !== "/profile", `${name}: left the page (${page.url()})`);
    // The service worker caches every page it serves; the signed-in ones must be gone
    // (it may already have cached the signed-out landing page again).
    const cached = await page.evaluate(async () => {
      if (!("caches" in self)) return [];
      const hits = await Promise.all(
        ["/profile", "/home", "/list"].map(async (p) => ((await caches.match(p)) ? p : null)),
      );
      return hits.filter(Boolean);
    });
    check(cached.length === 0, `${name}: no signed-in page cached (${cached.join(",") || "none"})`);

    await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
    check(/\/sign-in/.test(page.url()), `${name}: /profile now sends to /sign-in (${page.url()})`);

    const legacy = await page.goto(`${BASE}/auth/logout`, { waitUntil: "networkidle" });
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
