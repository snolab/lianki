import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = `qa+ui${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

const browser = await launchSilent(chromium);
const ctx = await newSilentContext(browser);
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
const badResponses = [];
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const log = (s) => console.log(s);
let ok = true;
const check = (cond, msg) => {
  log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

// A virtual platform authenticator (Touch ID-like: internal transport, resident
// keys, user verification), so the passkey flows below run headless. It lives
// in the browser, not the page, so it survives navigations in this tab.
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const credentialCount = async () =>
  (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length;
const getSession = () =>
  page.evaluate(async () => {
    const r = await fetch("/api/auth/get-session");
    return r.ok ? await r.json() : null;
  });

// 0. Owner-only /dev/roadmap is a 404 for a guest. ctx.request shares the
// context's cookies but fires no page events, so the expected 404 does not
// land in badResponses / console errors.
{
  const r = await ctx.request.get(`${BASE}/dev/roadmap`, { maxRedirects: 0 });
  if (r.status() === 404) log("✓ /dev/roadmap is 404 for a guest");
  else {
    log(`✗ /dev/roadmap for a guest: HTTP ${r.status()} (want 404)`);
    ok = false;
  }
}

// 1. Sign-in page
await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
log(`✓ sign-in page loaded: ${await page.title()}`);
check(
  (await page.locator("#email").getAttribute("autocomplete")) === "username webauthn",
  "email field offers passkeys in autofill (autocomplete=username webauthn)",
);
check(
  await page.getByRole("button", { name: "Sign in with a passkey" }).isVisible(),
  "sign-in page shows the passkey button",
);

// 2. Email → Continue
await page.locator("#email").fill(EMAIL);
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForSelector("#password", { timeout: 10000 });
log("✓ advanced to password step");

// 3. Password → Sign in (auto-signup on first use). With a platform
// authenticator present, the app then offers to add a passkey; turn it down
// here (the profile page adds one below) and land in the app.
await page.locator("#password").fill(PW);
await page.getByRole("button", { name: /sign in/i }).click();
{
  const suggestion = page.getByRole("heading", { name: "Sign in faster next time" });
  const offered = await suggestion
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(offered, "after an email sign-in, a passkey is offered");
  if (offered) {
    await Promise.all([
      page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: 20000 }),
      page.getByRole("button", { name: "Not now" }).click(),
    ]);
    check(
      (await page.evaluate(() => localStorage.getItem("lianki:passkey-suggestion-dismissed"))) ===
        "1",
      "'Not now' is remembered on this device",
    );
  }
}

// 4. Authenticated?
const session = await page.evaluate(async () => {
  const r = await fetch("/api/auth/get-session");
  return r.ok ? await r.json() : null;
});
if (session?.user?.email === EMAIL)
  log(`✓ authenticated as ${session.user.email} (url=${page.url()})`);
else {
  log(`✗ not authenticated; url=${page.url()}`);
  ok = false;
}

// 5. Dashboard + roadmap render while logged in
await page.goto(`${BASE}/list`, { waitUntil: "networkidle" });
log(`✓ dashboard loaded: ${await page.title()}`);
await page.goto(`${BASE}/roadmap`, { waitUntil: "networkidle" });
log(`✓ roadmap loaded: ${await page.title()}`);

// 5b. …and still a 404 for a signed-in user who is not in OWNER_EMAILS.
{
  const r = await ctx.request.get(`${BASE}/dev/roadmap`, { maxRedirects: 0 });
  if (r.status() === 404) log("✓ /dev/roadmap is 404 for a signed-in non-owner");
  else {
    log(`✗ /dev/roadmap for a non-owner: HTTP ${r.status()} (want 404)`);
    ok = false;
  }
}

// 5c0. Regressions from the iOS device QA (2026-10-29).
{
  // /list delete buttons once read "[object Object]" (IntlayerNode in an
  // attribute). Add a card so /list renders one.
  const added = await page.evaluate(async () => {
    const r = await fetch("/api/fsrs/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/qa-ui-delete", title: "QA delete" }),
    });
    return r.status;
  });
  await page.goto(`${BASE}/list`, { waitUntil: "networkidle" });
  const del = page.locator("li > button:last-child").first();
  const title = added === 200 ? await del.getAttribute("title").catch(() => null) : null;
  const label = added === 200 ? await del.getAttribute("aria-label").catch(() => null) : null;
  check(
    !!title && !!label && !/object Object/.test(title + label),
    `/list delete button has a real title and label ("${title}" / "${label}", add HTTP ${added})`,
  );

  // <html lang> follows the app locale (it read "en" under a French UI).
  await page.goto(`${BASE}/home?lang=fr`, { waitUntil: "networkidle" });
  const lang = await page.evaluate(() => document.documentElement.lang);
  check(lang === "fr", `<html lang> is the app locale on /home?lang=fr (${lang})`);
  // ?lang= sticks in a cookie: switch back so the English names below match.
  await page.goto(`${BASE}/home?lang=en`, { waitUntil: "networkidle" });

  // Phone width: the drawer is a modal dialog that Escape closes, and the
  // profile menu closes on a tap outside it (iOS never blurs its trigger).
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 414, height: 848 });
  await phone.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  await phone.getByRole("button", { name: "Menu", exact: true }).click();
  const drawer = phone.locator('[data-drawer][role="dialog"][aria-modal="true"]');
  const opened = await drawer
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const backdrop = await phone.getByRole("button", { name: "Close menu" }).count();
  await phone.keyboard.press("Escape");
  const closed = await drawer
    .waitFor({ state: "detached", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(
    opened && backdrop === 1 && closed,
    `drawer: a modal dialog, backdrop "Close menu", Escape closes it (${opened}/${backdrop}/${closed})`,
  );

  await phone.locator("[data-profile-menu]").click();
  const name = phone.locator("[data-debug-name]");
  await name.waitFor({ timeout: 5000 });
  await name.click();
  const stillOpen = await name.isVisible();
  // A plain tap on the page heading, outside the menu. Not locator.click():
  // that refuses because the open menu overlaps the point.
  const h1Box = await phone.locator("h1").first().boundingBox();
  await phone.mouse.click(h1Box.x + 4, h1Box.y + h1Box.height / 2);
  const shut = await name
    .waitFor({ state: "detached", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(
    stillOpen && shut,
    `profile menu: a tap on the name keeps it open, a tap outside closes it (${stillOpen}/${shut})`,
  );
  await phone.close();
}

// 5c. Passkeys: add one on the profile page, rename it, sign out, sign back in
// with it, then delete it.
{
  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await page.getByText("No passkeys yet.").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const list = page.getByTestId("passkey-list");
  await list.waitFor({ timeout: 20000 });
  check((await list.locator("li").count()) === 1, "profile: a passkey was added and is listed");
  check(/Chrome/.test(await list.locator("li").first().innerText()), "…named after the browser");
  check((await credentialCount()) === 1, "…and the authenticator holds one resident credential");

  await list.getByRole("button", { name: "Rename" }).click();
  await list.getByLabel("Passkey name").fill("QA key");
  await list.getByRole("button", { name: "Save" }).click();
  await list.getByText("QA key").waitFor({ timeout: 10000 });
  check(true, "profile: passkey renamed");

  const out = await page.evaluate(async () => {
    const r = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return r.status;
  });
  check(out === 200 && !(await getSession())?.user, "signed out");

  // Signed out, registration is refused outright.
  const reg = await ctx.request.get(`${BASE}/api/auth/passkey/generate-register-options`);
  check(reg.status() === 401, `register options need a session (HTTP ${reg.status()})`);

  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  // The autofill request may already have signed us in; otherwise use the button.
  if (/\/sign-in/.test(page.url()))
    await page
      .getByRole("button", { name: "Sign in with a passkey" })
      .click()
      .catch(() => {});
  await page
    .waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: 20000 })
    .catch(() => {});
  const back = await getSession();
  check(back?.user?.email === EMAIL, `signed back in with the passkey (url=${page.url()})`);

  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await list.waitFor({ timeout: 10000 });
  await list.getByRole("button", { name: "Delete" }).click();
  await list.getByRole("button", { name: "Delete" }).click(); // confirm
  await page.getByText("No passkeys yet.").waitFor({ timeout: 10000 });
  check(true, "profile: passkey deleted");
}

// 6. Console errors (ignore benign RSC prefetch aborts / 404 favicon / the
// passkey client logging the autofill request it abandons when the explicit
// passkey button starts its own / the
// Turnstile widget complaining about a missing sitekey — it gates only the
// magic-link button, not the password path this QA uses, and is undefined in
// any env without NEXT_PUBLIC_TURNSTILE_SITE_KEY configured, e.g. CI).
if (badResponses.length)
  log(`  4xx/5xx responses observed:\n    - ${badResponses.join("\n    - ")}`);
const real = errs.filter(
  (e) =>
    !/ERR_ABORTED|_rsc=|favicon|Failed to load resource.*40[01]|Cloudflare Turnstile.*sitekey|\[Better Auth\] Error verifying passkey/.test(
      e,
    ),
);
if (real.length) {
  log(`✗ console errors:\n  - ${real.slice(0, 8).join("\n  - ")}`);
  ok = false;
} else log("✓ no significant console errors (benign pre-auth 401/400 probes only)");

await browser.close();
log(`\n=== UI flow ${ok ? "PASSED" : "FAILED"} ===`);
process.exit(ok ? 0 : 1);
