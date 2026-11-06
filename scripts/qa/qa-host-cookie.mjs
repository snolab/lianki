#!/usr/bin/env bun
/**
 * The `__Host-` session cookie in a real browser (docs/secrets-and-auth.md, "The
 * session cookie"). qa:all runs on http, where the name stays plain, so this needs
 * its own server: the OpenNext Worker over https on local D1.
 *
 *   bunx wrangler dev --port <up> --ip 127.0.0.1 --local --host localhost:<p> --upstream-protocol https
 *   bun scripts/qa/qa-tls-proxy.ts <p> <up> <cert> <key>     # a self-signed localhost cert
 *   BASE=https://localhost:<p> bun scripts/qa/qa-host-cookie.mjs
 *
 * TLS is a small local proxy, as Cloudflare terminates it in production: on this Mac
 * `wrangler dev --local-protocol https` never answers. --host makes the Worker see the
 * public https URL; without it wrangler rewrites Origin to http and sign-up is 403.
 *
 * .dev.vars: BETTER_AUTH_BASE_URL=$BASE, DEV_EMAIL_PASSWORD_AUTH=1, NODE_ENV=development,
 * and made-up AUTH_GITHUB_ID / AUTH_GITHUB_SECRET for the OAuth state cookie (no call
 * leaves this machine). Not part of qa:all.
 */
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.BASE;
const NEW = "__Host-better-auth.session_token";
const OLD = "__Secure-better-auth.session_token";
const PW = "qa-host-cookie-pass-1";
const STAMP = Date.now();

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const browser = await launchSilent(chromium);
const fresh = () =>
  newSilentContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
const names = async (ctx) => (await ctx.cookies()).map((c) => c.name);
const cookie = async (ctx, name) => (await ctx.cookies()).find((c) => c.name === name);

async function signUp(ctx, email) {
  const r = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: { email, password: PW, name: "qa" },
    headers: { origin: BASE },
  });
  if (!r.ok()) throw new Error(`sign-up ${r.status()}`);
  return r;
}
const session = async (ctx) => {
  const r = await ctx.request.get(`${BASE}/api/auth/get-session`);
  return r.ok() ? await r.json() : null;
};

/** Opens a path and stays a while: how many times did the page move, and where did it end? */
async function settle(ctx, path) {
  const page = await ctx.newPage();
  let moves = 0;
  const seen = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      moves++;
      seen.push(new URL(f.url()).pathname);
    }
  });
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(4000);
  const end = new URL(page.url()).pathname;
  await page.close();
  return { moves, end, seen };
}

// ── What the browser actually keeps ──────────────────────────────────────────
const main = await fresh();
const EMAIL = `qa+host-${STAMP}@lianki.test`;
const signedUp = await signUp(main, EMAIL);
const c = await cookie(main, NEW);
check("signing in sets the __Host- session cookie, and the browser keeps it", Boolean(c));
check("Secure, HttpOnly, Lax", c?.secure && c?.httpOnly && c?.sameSite === "Lax");
check("Path=/ and host-only", c?.path === "/" && !c?.domain?.startsWith("."), c?.domain);
check("no __Secure- cookie is set", !(await names(main)).some((n) => n.startsWith("__Secure-")));
const setLines = signedUp.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
check(
  "nothing is named __Secure-__Host-",
  setLines.length > 0 && !setLines.some((h) => h.value.includes("__Secure-__Host-")),
);
check("the session works", (await session(main))?.user?.email === EMAIL);

// ── The point of it: a page cannot plant one with a Domain ───────────────────
const tossPage = await main.newPage();
await tossPage.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
const planted = await tossPage.evaluate(() => {
  document.cookie = "__Host-qa-plain=1; Secure; Path=/";
  document.cookie = "__Host-qa-domain=1; Secure; Path=/; Domain=localhost";
  document.cookie = "__Host-qa-path=1; Secure; Path=/sub";
  document.cookie = "__Host-better-auth.session_token=forged; Secure; Path=/; Domain=localhost";
  return document.cookie;
});
await tossPage.close();
check(
  "control: a plain __Host- cookie can be set from a page",
  planted.includes("__Host-qa-plain=1"),
);
check("one with a Domain is refused by the browser", !planted.includes("__Host-qa-domain"));
check("so is one with another Path", !planted.includes("__Host-qa-path"));
check("and the real session cookie is not replaced", (await cookie(main, NEW))?.value === c?.value);

// ── The hub's view: identity and session tag, as lianki-push asks for them ───
const id = await main.request.get(`${BASE}/api/debug/identity`);
const idBody = id.ok() ? await id.json() : {};
check("/api/debug/identity answers for the new cookie", id.status() === 200, `${id.status()}`);
check(
  "with a session tag for eval grants",
  typeof idBody.session === "string" && idBody.session.length > 0,
);

// ── API tokens do not depend on the cookie ───────────────────────────────────
const mainPage = await main.newPage();
await mainPage.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
const minted = await mainPage.evaluate(async () => {
  const r = await fetch("/api/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "qa" }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
});
await mainPage.close();
check(
  "an API token can be made",
  minted.status === 200 && Boolean(minted.body.token),
  `${minted.status}`,
);
const bare = await fresh();
const withToken = () =>
  bare.request.get(`${BASE}/api/prefs`, {
    headers: { authorization: `Bearer ${minted.body.token}` },
  });
const byToken = await withToken();
check("it works with no cookie at all", byToken.status() === 200, `${byToken.status()}`);

// ── The OAuth state cookie ───────────────────────────────────────────────────
const social = await fresh();
const started = await social.request.post(`${BASE}/api/auth/sign-in/social`, {
  data: { provider: "github", callbackURL: "/home" },
  headers: { origin: BASE },
});
const socialNames = await names(social);
check("OAuth sign-in starts", started.status() === 200, `${started.status()}`);
check(
  "its state cookie is __Host- too, and the browser keeps it",
  socialNames.some((n) => n.startsWith("__Host-better-auth.") && n.includes("state")),
  socialNames.join(" "),
);
await social.close();

// ── Holding only the old cookie: signed out once, no loop ────────────────────
const token = c?.value ?? "";
for (const path of [
  "/",
  "/en",
  "/home",
  "/words",
  "/review",
  "/list",
  "/profile",
  "/membership",
  "/sign-in",
]) {
  const ctx = await fresh();
  await ctx.addCookies([
    { name: OLD, value: token, url: BASE, secure: true, httpOnly: true, sameSite: "Lax" },
    {
      name: "__Secure-better-auth.session_data",
      value: "x",
      url: BASE,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const r = await settle(ctx, path);
  check(`old cookie on ${path}: settles`, r.moves <= 3, `${r.moves} moves, ends ${r.end}`);
  check(
    `  and both old cookies are gone`,
    !(await names(ctx)).some((n) => n.startsWith("__Secure-")),
  );
  check(
    `  and is not signed in, even with a live token under the old name`,
    !(await session(ctx))?.user,
  );
  await ctx.close();
}

// ── Then signing in works first time, and stays ──────────────────────────────
const back = await fresh();
await back.addCookies([
  { name: OLD, value: token, url: BASE, secure: true, httpOnly: true, sameSite: "Lax" },
]);
const p = await back.newPage();
await p.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
await p.waitForURL(/\/sign-in/, { timeout: 60_000 });
check("a protected page sends them to sign-in", true);
await p.locator("#email").fill(EMAIL);
await p.getByRole("button", { name: "Continue" }).click();
await p.locator("#password").fill(PW);
await p.getByRole("button", { name: /sign in/i }).click();
await p.waitForFunction(() => !location.pathname.startsWith("/sign-in"), null, { timeout: 60_000 });
check("signing in by hand leaves the sign-in page", true, new URL(p.url()).pathname);
check("with the new cookie", Boolean(await cookie(back, NEW)));
check("and no old one", !(await names(back)).some((n) => n.startsWith("__Secure-")));
await p.close();
const after = await settle(back, "/profile");
check(
  "a protected page now stays",
  after.end === "/profile" && after.moves <= 2,
  `${after.moves} moves, ends ${after.end}`,
);

// ── Passkeys: same credential table, new challenge cookie ────────────────────
const pk = await fresh();
await signUp(pk, `qa+host-pk-${STAMP}@lianki.test`);
const pp = await pk.newPage();
const cdp = await pk.newCDPSession(pp);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
});
const challengeNames = new Set();
pp.on("response", async (r) => {
  if (!r.url().includes("/passkey/")) return;
  for (const h of await r.headersArray())
    if (h.name.toLowerCase() === "set-cookie") challengeNames.add(h.value.split("=")[0]);
});
await pp.goto(`${BASE}/profile`, { waitUntil: "networkidle", timeout: 120_000 });
await pp.getByRole("button", { name: "Add a passkey" }).click();
await pp.getByTestId("passkey-list").locator("li").first().waitFor({ timeout: 30_000 });
const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length;
check("a passkey can be added", creds === 1, `${creds}`);
check(
  "its challenge cookie is __Host-",
  [...challengeNames].some((n) => n.startsWith("__Host-better-auth.")) &&
    ![...challengeNames].some((n) => n.startsWith("__Secure-")),
  [...challengeNames].join(" "),
);
await pk.clearCookies();
check("signed out before the passkey sign-in", !(await session(pk))?.user);
await pp.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
// The autofill request may already have signed in (as in qa-ui.mjs); otherwise the button.
if (/\/sign-in/.test(pp.url()))
  await pp
    .getByRole("button", { name: "Sign in with a passkey" })
    .click({ timeout: 5000 })
    .catch(() => {});
await pp.waitForFunction(() => !location.pathname.startsWith("/sign-in"), null, {
  timeout: 60_000,
});
check(
  "signing in with that passkey works",
  Boolean((await session(pk))?.user) && Boolean(await cookie(pk, NEW)),
);
await pp.close();
await pk.close();

// ── The migration, on someone mid-session ────────────────────────────────────
const mid = await fresh();
await signUp(mid, `qa+host-mid-${STAMP}@lianki.test`);
check("a session before the migration", Boolean((await session(mid))?.user));
const midTag = await (await mid.request.get(`${BASE}/api/debug/identity`)).json();
const run = Bun.spawnSync(
  [
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "lianki",
    "--local",
    "--file",
    "db/migrations/0050_host_session_cookie.sql",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
check("the migration runs on a live database", run.exitCode === 0, `${run.exitCode}`);
check("that session is over on the server", !(await session(mid))?.user);
const gone = await mid.request.get(`${BASE}/api/debug/identity`);
check(
  "so the hub's identity check refuses it",
  gone.status() === 401,
  `${gone.status()} (had a tag: ${Boolean(midTag.session)})`,
);
const r2 = await settle(mid, "/profile");
check(
  "and the page settles at sign-in",
  r2.end === "/sign-in" && r2.moves <= 3,
  `${r2.moves} moves, ends ${r2.end}`,
);
await mid.close();
check("API tokens survive it", (await withToken()).status() === 200);
const again = await fresh();
await again.request.post(`${BASE}/api/auth/sign-in/email`, {
  data: { email: EMAIL, password: PW },
  headers: { origin: BASE },
});
check("and signing in again works", (await session(again))?.user?.email === EMAIL);

// ── Signing out clears them all ──────────────────────────────────────────────
const out = await again.request.post(`${BASE}/api/auth/sign-out`, {
  headers: { origin: BASE },
  data: {},
});
check("sign-out answers", out.ok(), `${out.status()}`);
check(
  "and leaves no session cookie",
  !(await names(again)).some((n) => n.includes("session_token")),
  (await names(again)).join(" "),
);
check("an API token outlives a sign-out", (await withToken()).status() === 200);

await browser.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
