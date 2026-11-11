// The account's UI language on the server (lib/account-locale.ts): a signed-in
// user on a new device gets the account's language on the FIRST response, not
// the browser's first and then a switch (owner plan, 2026-11-09).
//
// Signs up a throwaway account in a German browser (signupLocale = de), then
// opens fresh contexts that carry only the session cookie, in an English
// browser with no `lang` cookie:
//   - the first HTML of /home is German (signupLocale);
//   - with ui.locale = zh on the account, the first HTML is Chinese;
//   - after that page, the browser keeps `lang=zh` and `lang_src=acct`;
//   - ?lang=ja still wins, and sticks for the session over the account;
//   - Settings shows the Language section.
//
//   QA_BASE=http://localhost:3000 bun scripts/qa/qa-account-locale.mjs
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const PW = "qa-test-pass-1234";
const EMAIL = `qa+acctlang-${Date.now()}@lianki.test`;
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};
const htmlLang = (html) => /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1] ?? null;

const browser = await launchSilent(chromium);
try {
  // 1. Sign up in a German browser.
  const a = await newSilentContext(browser, {
    viewport: { width: 390, height: 844 },
    locale: "de-DE",
  });
  const page = await a.newPage();
  await page.goto(`${BASE}/sign-in?lang=en`, { waitUntil: "networkidle" });
  await page.locator("#email").fill(EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#password").fill(PW);
  await page.getByRole("button", { name: /sign in/i }).click();
  const notNow = page.getByRole("button", { name: "Not now" });
  await Promise.race([
    page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: budget(30000) }),
    notNow.waitFor({ timeout: budget(30000) }).then(() => notNow.click()),
  ]);
  await page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: budget(30000) });
  const session = (await a.cookies()).filter((c) => c.name.includes("better-auth"));
  check(session.length > 0, "signed up, session cookie set");

  /** A new device: only the session cookie, an English browser, no `lang` cookie. */
  const freshDevice = async () => {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 844 },
      locale: "en-US",
    });
    await ctx.addCookies(session);
    return ctx;
  };
  const firstHtml = async (ctx, path) => {
    const r = await ctx.request.get(`${BASE}${path}`, {
      headers: { "accept-language": "en-US,en;q=0.9" },
      maxRedirects: 0,
    });
    return { status: r.status(), lang: htmlLang(await r.text()) };
  };

  // 2. No ui.locale yet: the language at sign-up (de).
  {
    const ctx = await freshDevice();
    const r = await firstHtml(ctx, "/home");
    check(
      r.status === 200 && r.lang === "de",
      `no ui.locale: first /home is de (${r.status} ${r.lang})`,
    );
    await ctx.close();
  }

  // 3. ui.locale = zh on the account.
  const put = await page.evaluate(async () => {
    const r = await fetch("/api/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            key: "ui.locale",
            value: "zh",
            hlc: { timestamp: Date.now(), counter: 0, deviceId: "qaacctlang1" },
          },
        ],
      }),
    });
    return r.status;
  });
  check(put === 200, `ui.locale=zh saved (${put})`);

  {
    const ctx = await freshDevice();
    const r = await firstHtml(ctx, "/home");
    check(
      r.status === 200 && r.lang === "zh-Hans",
      `ui.locale=zh: FIRST /home is zh (${r.status} ${r.lang})`,
    );

    // The page remembers it: the next request needs no account read.
    const p = await ctx.newPage();
    await p.goto(`${BASE}/words`, { waitUntil: "networkidle" });
    check((await p.locator("html").getAttribute("lang")) === "zh-Hans", "/words in a browser: zh");
    const jar = Object.fromEntries((await ctx.cookies()).map((c) => [c.name, c.value]));
    check(
      jar.lang === "zh" && jar.lang_src === "acct",
      `adopted: lang=${jar.lang} lang_src=${jar.lang_src}`,
    );

    // An explicit ?lang= wins, and holds for the session over the account.
    const ja = await firstHtml(ctx, "/home?lang=ja");
    check(ja.lang === "ja", `?lang=ja wins over the account (${ja.lang})`);
    const after = await firstHtml(ctx, "/home");
    check(after.lang === "ja", `the pick holds this session (${after.lang})`);
    await ctx.close();
  }

  // 4. A guest in the same English browser stays English.
  {
    const ctx = await newSilentContext(browser, { locale: "en-US" });
    const r = await firstHtml(ctx, "/sign-in");
    check(r.lang === "en", `a guest stays on Accept-Language (${r.lang})`);
    await ctx.close();
  }

  // 5. Settings → Language.
  await page.goto(`${BASE}/my/preferences?lang=en`, { waitUntil: "networkidle" });
  const section = page.locator('[data-testid="language-settings"]');
  check((await section.count()) === 1, "Settings has the Language section");
  check(
    (await section.locator("[data-lang-trigger]").count()) === 1,
    "with the language picker in it",
  );
} catch (e) {
  check(false, `${e.message.split("\n")[0]}`);
} finally {
  await browser.close();
}

console.log(ok ? "\naccount-locale: all checks passed" : "\naccount-locale: FAILED");
process.exit(ok ? 0 : 1);
