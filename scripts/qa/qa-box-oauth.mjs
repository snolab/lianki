#!/usr/bin/env bun
/**
 * End to end for a box signing in through lianki.com (docs/box-oauth.md), in a
 * real browser against the real provider code: the OpenNext Worker under
 * `wrangler dev` on local D1 as lianki.com, and a second, separate `next dev`
 * as the box on another origin, from its own checkout (a shared .next breaks it).
 * Nothing leaves this machine.
 *
 *   PROVIDER=http://127.0.0.1:<port> BOX=http://127.0.0.1:<port> OWNER=<email> \
 *     bun scripts/qa/qa-box-oauth.mjs setup     # prints the client id for the box's env
 *   … bun scripts/qa/qa-box-oauth.mjs run
 *
 * The provider needs DEV_EMAIL_PASSWORD_AUTH=1, and in its local D1 the flag on and
 * OWNER in site_role. Use 127.0.0.1, not localhost: the plugin allows http only for a
 * native client on a loopback address. The box needs LIANKI_BOX_CLIENT_ID and
 * LIANKI_BOX_PROVIDER. It ends by revoking, so `setup` again before another `run`.
 * Not part of qa:all: it needs a second server.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { launchSilent, newSilentContext } from "./silent.mjs";

const PROVIDER = process.env.PROVIDER;
const BOX = process.env.BOX;
const OWNER = process.env.OWNER;
// The client id between `setup` and a run: in the repo's gitignored .wrangler/, owner-only,
// never a shared temp dir.
const STATE = process.env.STATE ?? ".wrangler/qa-box-oauth.json";
const saveState = (v) => {
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(STATE, JSON.stringify(v), { mode: 0o600 });
};
const PASSWORD = "qa-box-oauth-pass-1";
const MEMBER = "qa-box-member@lianki.test";
const STRANGER = "qa-box-stranger@lianki.test";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

async function signUp(ctx, email) {
  const r = await ctx.request.post(`${PROVIDER}/api/auth/sign-up/email`, {
    data: { email, password: PASSWORD, name: email.split("@")[0] },
    headers: { origin: PROVIDER },
  });
  if (r.ok()) return;
  const again = await ctx.request.post(`${PROVIDER}/api/auth/sign-in/email`, {
    data: { email, password: PASSWORD },
    headers: { origin: PROVIDER },
  });
  if (!again.ok()) throw new Error(`cannot sign in ${email}: ${again.status()}`);
}

async function setup() {
  const browser = await launchSilent(chromium);
  const ctx = await newSilentContext(browser);
  await signUp(ctx, OWNER);
  const member = await newSilentContext(browser);
  await signUp(member, MEMBER);
  await member.close();
  const r = await ctx.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data: { op: "add", origin: BOX, email: MEMBER, scopes: ["box:read", "box:write"] },
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });
  const body = await r.json();
  if (!r.ok()) throw new Error(`bind: ${r.status()} ${JSON.stringify(body)}`);
  saveState({ clientId: body.clientId });
  console.log(`clientId=${body.clientId}`);
  await browser.close();
}

const pageApi = (page, path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, i);
      return { status: r.status, text: (await r.text()).slice(0, 300) };
    },
    [path, init],
  );

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Walks the real flow in a real page and stops at the box's callback, holding the code. */
async function getCode(ctx, clientId, scope) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${BOX}/box-callback`,
    scope,
    state: "qa",
    code_challenge: b64url(digest),
    code_challenge_method: "S256",
  });
  const page = await ctx.newPage();
  let code = null;
  // Seen on its way to the box. The box's page does not spend it: no state of its own.
  page.on("request", (r) => {
    if (r.url().startsWith(`${BOX}/box-callback`) && r.isNavigationRequest())
      code = new URL(r.url()).searchParams.get("code");
  });
  await page.goto(`${PROVIDER}/box-authorize?${q}`);
  for (let i = 0; i < 40 && !code; i++) await page.waitForTimeout(250);
  await page.close();
  return { code, verifier };
}

/** The token endpoint from outside a browser, as the gate sees a box. */
const exchange = (ctx, clientId, code, verifier) =>
  ctx.request.post(`${PROVIDER}/api/auth/oauth2/token`, {
    headers: { origin: BOX, cookie: "" },
    form: {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: `${BOX}/box-callback`,
      code_verifier: verifier,
    },
  });

/** A token call with no browser to block it, so the status is the server's own. */
const raw = (token, path, method = "GET") =>
  fetch(`${PROVIDER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: BOX,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify({ ops: [] }) }),
  });

const signInLinks = (page) => page.locator('header a[href="/sign-in"]').count();
const settled = (page) =>
  page.waitForFunction(() => !document.querySelector('[data-box-session="loading"]'), null, {
    timeout: 30_000,
  });

/** Signed in on the box: what the page shows and what it can ask. */
async function signedInView(ctx, page, boxCookies) {
  const html = await (await ctx.request.get(`${BOX}/home`)).text();
  check(
    "the box's server HTML is a spinner, not a sign-in link",
    html.includes('data-box-session="loading"') && !html.includes('href="/sign-in"'),
  );
  await settled(page);
  await page.waitForSelector("[data-profile-menu]", { timeout: 30_000 });
  check("the header shows the account, no sign-in link", (await signInLinks(page)) === 0);
  await page.click("[data-profile-menu]");
  const named = await page.locator("[data-debug-name]").innerText();
  check("the account menu names the bound account", named.includes(MEMBER), named);
  await page.keyboard.press("Escape");

  const who = await pageApi(page, "/api/box/me");
  const user = JSON.parse(who.text || "{}").user ?? {};
  check(
    "/api/box/me names the bound account",
    who.status === 200 && user.email === MEMBER,
    `${who.status}`,
  );
  check(
    "and gives only name, email and avatar",
    JSON.stringify(Object.keys(user).sort()) === '["email","image","name"]',
  );
  // On 127.0.0.1 the two servers share one cookie jar (cookies ignore the port),
  // so what counts is that no box response sets one.
  check(
    "the box sets no session cookie",
    !boxCookies.some((c) => /session|auth/i.test(c)),
    boxCookies.join(" | ").slice(0, 120),
  );

  // The landing page has its own header (app/[locale]).
  await page.goto(`${BOX}/en`);
  await settled(page);
  await page.waitForTimeout(500);
  check("the landing page's header is signed in too", (await signInLinks(page)) === 0);

  // A page that redirects on the server stops at /sign-in instead of going round.
  await page.goto(`${BOX}/learn`);
  await page.waitForSelector("[data-box-signed-in]", { timeout: 30_000 });
  check("a server-gated page does not loop through lianki.com", page.url().startsWith(BOX));

  await page.goto(`${BOX}/home`);
  await settled(page);
}

/** Sign-out on the box revokes at lianki.com and leaves no token behind. */
async function boxSignOutCheck(browser, clientId) {
  const ctx = await newSilentContext(browser);
  await signUp(ctx, MEMBER);
  const page = await ctx.newPage();
  await page.goto(`${BOX}/sign-in`);
  await page.waitForURL(`${BOX}/home**`, { timeout: 90_000 });
  await settled(page);
  const before = JSON.parse(await page.evaluate(() => sessionStorage.getItem("lk:box:tokens")));
  await page.click("[data-profile-menu]");
  await page.click("[data-sign-out]");
  await page.waitForURL((u) => !u.pathname.startsWith("/home"), { timeout: 30_000 });
  await settled(page);
  await page.waitForSelector('header a[href="/sign-in"]', { timeout: 30_000 });
  check("after sign-out the box's header offers sign-in", true);
  check(
    "and the tab holds no token",
    (await page.evaluate(() => sessionStorage.getItem("lk:box:tokens"))) === null,
  );
  const refresh = await fetch(`${PROVIDER}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { origin: BOX, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: before.refresh,
    }),
  });
  check("its refresh token is revoked at lianki.com", refresh.status >= 400, `${refresh.status}`);
  await ctx.close();
}

async function run() {
  const { clientId } = JSON.parse(readFileSync(STATE, "utf8"));
  const browser = await launchSilent(chromium);

  // The bound member signs in at the provider, then opens the box.
  const ctx = await newSilentContext(browser);
  await signUp(ctx, MEMBER);
  const page = await ctx.newPage();
  const cross = [];
  const boxCookies = [];
  page.on("response", (r) => {
    if (r.url().startsWith(`${PROVIDER}/api/`)) cross.push(r);
    const set = r.url().startsWith(BOX) && r.headers()["set-cookie"];
    if (set) boxCookies.push(set.split(";")[0]);
  });
  await page.goto(`${BOX}/sign-in`);
  await page.waitForURL(`${BOX}/home**`, { timeout: 90_000 });
  check("sign-in on the box goes through the provider and comes back", true);
  check("the code is gone from the URL", !page.url().includes("code="));
  const stored = await page.evaluate(() => sessionStorage.getItem("lk:box:tokens") ?? "");
  const access = JSON.parse(stored || "{}").access ?? "";
  check("a box token is held", access.startsWith("lkb_"));

  // The box's signed-in view (docs/box-oauth.md): header, menu and pages show the
  // account from lianki.com; the server's HTML holds a spinner, never "Sign in".
  await signedInView(ctx, page, boxCookies);

  const prefs = await pageApi(page, "/api/prefs");
  const me = await (await ctx.request.get(`${PROVIDER}/api/auth/get-session`)).json();
  check("the page's /api call reaches the provider", prefs.status === 200, `${prefs.status}`);
  check("as the bound account, not just any", JSON.parse(prefs.text || "{}").user === me?.user?.id);
  const put = await pageApi(page, "/api/prefs", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [] }),
  });
  check(
    "a write with box:write reaches the route",
    put.status === 200 || put.status === 400,
    `${put.status}`,
  );

  const direct = (path, init = {}) =>
    pageApi(page, `${PROVIDER}${path}`, {
      credentials: "omit",
      ...init,
      headers: { authorization: `Bearer ${access}`, ...init.headers },
    });
  for (const path of [
    "/api/dev/flags",
    "/api/dev/box-clients",
    "/api/token",
    "/api/payments/checkout",
    "/api/auth/update-user",
    "/api/auth/get-session",
  ]) {
    const r = await direct(path);
    check(`token refused on ${path}`, r.status === 404, `${r.status}`);
  }
  const included = await page.evaluate(
    async ([u, a]) => {
      try {
        const r = await fetch(u, {
          credentials: "include",
          headers: { authorization: `Bearer ${a}` },
        });
        return `read:${r.status}`;
      } catch {
        return "blocked";
      }
    },
    [`${PROVIDER}/api/prefs`, access],
  );
  check("credentials: include cannot be read", included === "blocked", included);
  check(
    "no CORS grant allows credentials",
    cross.every((r) => !r.headers()["access-control-allow-credentials"]),
  );
  check(
    "no cookie is set by a box response",
    cross.every((r) => !r.headers()["set-cookie"]),
  );

  const refreshed = await page.evaluate(
    async ([u, c]) => {
      const t = JSON.parse(sessionStorage.getItem("lk:box:tokens"));
      const r = await fetch(u, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: c,
          refresh_token: t.refresh,
        }),
      });
      const b = await r.json().catch(() => ({}));
      // The old refresh token is spent: rotation.
      const again = await fetch(u, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: c,
          refresh_token: t.refresh,
        }),
      });
      if (b.access_token)
        sessionStorage.setItem(
          "lk:box:tokens",
          JSON.stringify({
            access: b.access_token,
            refresh: b.refresh_token,
            until: Date.now() + b.expires_in * 1000,
          }),
        );
      return {
        status: r.status,
        access: b.access_token ?? "",
        changed: b.refresh_token !== t.refresh,
        again: again.status,
        expires: b.expires_in,
      };
    },
    [`${PROVIDER}/api/auth/oauth2/token`, clientId],
  );
  check(
    "refresh gives a new token",
    refreshed.status === 200 && refreshed.access.startsWith("lkb_"),
    `${refreshed.status}`,
  );
  check("and rotates the refresh token", refreshed.changed);
  check(
    "tokens are short-lived",
    refreshed.expires > 0 && refreshed.expires <= 900,
    `${refreshed.expires}s`,
  );

  // PKCE and one-time codes, with real codes. Cookies stripped: the browser context's
  // request API would otherwise add them, and a cookie is refused by itself.
  const bare = await newSilentContext(browser);
  const wrongPkce = await getCode(ctx, clientId, "box:read box:write offline_access");
  check("a real code is issued", Boolean(wrongPkce.code));
  const bad = await exchange(bare, clientId, wrongPkce.code, "x".repeat(50));
  check(
    "a real code with the wrong verifier gets no token",
    Boolean(wrongPkce.code) && bad.status() >= 400,
    `${bad.status()}`,
  );
  const good = await getCode(ctx, clientId, "box:read box:write offline_access");
  const first = await exchange(bare, clientId, good.code, good.verifier);
  const firstBody = await first.json().catch(() => ({}));
  check(
    "the right verifier gets one",
    first.status() === 200 && Boolean(firstBody.access_token),
    `${first.status()}`,
  );
  const replayed = await exchange(bare, clientId, good.code, good.verifier);
  check(
    "the same code again gets nothing: one-time",
    first.status() === 200 && replayed.status() >= 400,
    `${replayed.status()}`,
  );
  check("the token response sets no cookie", !first.headers()["set-cookie"]);
  await bare.close();

  // A replayed code also ends what that code issued (RFC 6749 4.1.2).
  const burnt = await raw(firstBody.access_token, "/api/prefs");
  check("a replay revokes the token that code issued", burnt.status === 401, `${burnt.status}`);

  const again = await getCode(ctx, clientId, "box:read box:write offline_access");
  const fresh = await newSilentContext(browser);
  const live = (await (await exchange(fresh, clientId, again.code, again.verifier)).json())
    .access_token;
  await fresh.close();
  check("the token works without a browser", (await raw(live, "/api/prefs")).status === 200);
  const withCookie = await fetch(`${PROVIDER}/api/prefs`, {
    headers: {
      authorization: `Bearer ${live}`,
      origin: BOX,
      cookie: "better-auth.session_token=x",
    },
  });
  check("a token with a cookie is refused", withCookie.status === 400, `${withCookie.status}`);
  const otherOrigin = await fetch(`${PROVIDER}/api/prefs`, {
    headers: { authorization: `Bearer ${live}`, origin: "https://my-0000000000000000.lianki.com" },
  });
  check(
    "a token from another origin is refused",
    otherOrigin.status === 403,
    `${otherOrigin.status}`,
  );
  const noOrigin = await fetch(`${PROVIDER}/api/prefs`, {
    headers: { authorization: `Bearer ${live}` },
  });
  check("a token with no origin is refused", noOrigin.status === 403, `${noOrigin.status}`);
  const noBack = await fetch(`${PROVIDER}/api/prefs`, {
    headers: { authorization: "Bearer lkb_0000000000000000000000000000", origin: BOX },
  });
  check("an unknown token gets 401", noBack.status === 401, `${noBack.status}`);
  const sibling = await ctx.request.post(`${PROVIDER}/api/prefs`, {
    headers: { origin: BOX, "sec-fetch-site": "same-site", "content-type": "application/json" },
    data: {},
  });
  check(
    "a sibling's cookie request to /api is refused",
    sibling.status() === 403,
    `${sibling.status()}`,
  );

  // The real limit, on its own token.
  let limited = 0;
  for (let i = 0; i < 40 && !limited; i++) {
    const batch = await Promise.all(Array.from({ length: 10 }, () => raw(live, "/api/levels/me")));
    limited = batch.find((r) => r.status === 429) ? (i + 1) * 10 : 0;
  }
  check("the per-token limit bites", limited >= 300 && limited <= 330, `after ${limited} requests`);

  // Replay of the one-time code and a wrong verifier.
  const replay = await page.evaluate(
    async ([u, c, b]) => {
      const r = await fetch(u, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: c,
          code: "used-or-made-up",
          redirect_uri: `${b}/box-callback`,
          code_verifier: "x".repeat(50),
        }),
      });
      return r.status;
    },
    [`${PROVIDER}/api/auth/oauth2/token`, clientId, BOX],
  );
  check("a made-up code gets no token", replay >= 400, `${replay}`);

  // The plugin's other routes stay shut for a signed-in user.
  for (const path of [
    "/api/auth/oauth2/create-client",
    "/api/auth/oauth2/register",
    "/api/auth/oauth2/get-clients",
    "/api/auth/oauth2/consent",
    "/api/auth/admin/oauth2/create-client",
    "/api/auth/.well-known/oauth-authorization-server",
  ]) {
    const r = await ctx.request.fetch(`${PROVIDER}${path}`, {
      method: path.includes("get-clients") || path.includes("well-known") ? "GET" : "POST",
      data: path.includes("get-clients") || path.includes("well-known") ? undefined : {},
      headers: { origin: PROVIDER },
    });
    check(`plugin route shut: ${path}`, r.status() === 404, `${r.status()}`);
  }

  // Wrong redirect URI at the entry.
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${BOX}/elsewhere`,
    scope: "box:read",
    state: "s",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  });
  const wrong = await ctx.request.get(`${PROVIDER}/box-authorize?${q}`, { maxRedirects: 0 });
  check("a redirect URI that is not exact is refused", wrong.status() === 404, `${wrong.status()}`);
  const direct2 = await ctx.request.get(`${PROVIDER}/api/auth/oauth2/authorize?${q}`, {
    maxRedirects: 0,
  });
  const loc = direct2.headers().location ?? "";
  check(
    "nor does the plugin send a code there directly",
    direct2.status() >= 300 && !loc.startsWith(`${BOX}/elsewhere`),
    `${direct2.status()}`,
  );

  // Any other account is refused at the provider.
  const other = await newSilentContext(browser);
  await signUp(other, STRANGER);
  const op = await other.newPage();
  await op.goto(`${BOX}/sign-in`);
  await op.waitForURL(`${PROVIDER}/**`, { timeout: 60_000 });
  await op.waitForLoadState();
  check(
    "another account stays on the provider, refused",
    (await op.content()).includes("another Lianki account"),
  );
  check("and no token reaches the box", !op.url().startsWith(BOX));
  const q2 = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${BOX}/box-callback`,
    scope: "box:read",
    state: "s",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  });
  const bypass = await other.request.get(`${PROVIDER}/api/auth/oauth2/authorize?${q2}`, {
    maxRedirects: 0,
  });
  check(
    "calling the plugin directly as that account is refused too",
    bypass.status() === 403,
    `${bypass.status()}`,
  );
  // JS on lianki.com with a session (a ?live custom frontend) must not read a code.
  const home = await ctx.newPage();
  await home.goto(`${PROVIDER}/sign-in`);
  const q3 = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${BOX}/box-callback`,
    scope: "box:read",
    state: "s",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  });
  const sameOrigin = await home.evaluate(async (u) => {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    return { status: r.status, text: await r.text() };
  }, `/api/auth/oauth2/authorize?${q3}`);
  check(
    "same-origin fetch by the bound account gets no code",
    sameOrigin.status === 403 && !sameOrigin.text.includes("code="),
    `${sameOrigin.status}`,
  );
  const framed = await home.evaluate(async (u) => {
    const f = document.createElement("iframe");
    f.src = u;
    document.body.append(f);
    await new Promise((r) => setTimeout(r, 2500));
    try {
      return f.contentWindow.location.href;
    } catch {
      return "cross-origin";
    }
  }, `/box-authorize?${q3}`);
  check(
    "the entry does not load in a frame",
    !String(framed).includes("/box-authorize") || String(framed).startsWith("chrome-error"),
    String(framed).slice(0, 40),
  );
  await home.close();
  await other.close();

  await boxSignOutCheck(browser, clientId);

  // A box with no account gets the sign-in of lianki.com, not its own.
  const anon = await newSilentContext(browser);
  const ap = await anon.newPage();
  await ap.goto(`${BOX}/sign-in`);
  await ap.waitForURL(`${PROVIDER}/sign-in**`, { timeout: 60_000 });
  check("signed out, the box's sign-in lands on the provider's sign-in", true);
  const local = await anon.request.post(`${BOX}/api/auth/sign-up/email`, {
    data: { email: "x@lianki.test", password: PASSWORD, name: "x" },
    headers: { origin: BOX },
  });
  check("the box's own sign-up is gone", local.status() === 404, `${local.status()}`);
  await anon.close();

  // The one owner action.
  const owner = await newSilentContext(browser);
  await signUp(owner, OWNER);
  const rev = await owner.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data: { op: "revoke", clientId },
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });
  check("the owner revokes the box", rev.ok(), `${rev.status()}`);
  check("its token gets 401 from the server", (await raw(access, "/api/prefs")).status === 401);
  const t = JSON.parse(await page.evaluate(() => sessionStorage.getItem("lk:box:tokens")));
  const refreshAfter = await fetch(`${PROVIDER}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { origin: BOX, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: t.refresh,
    }),
  });
  check(
    "its refresh token is refused by the server",
    refreshAfter.status >= 400,
    `${refreshAfter.status}`,
  );
  check(
    "a new code cannot be had",
    wrongPkce.code && !(await getCode(ctx, clientId, "box:read")).code,
  );

  // A read-only box, for real.
  const rebound = await owner.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data: { op: "add", origin: BOX, email: MEMBER, scopes: ["box:read"] },
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });
  const ro = (await rebound.json()).clientId;
  check("the same origin and account can be bound again after a revoke", Boolean(ro));
  const beyond = await getCode(ctx, ro, "box:read box:write offline_access");
  check("a read-only client cannot get box:write", !beyond.code);
  const rc = await getCode(ctx, ro, "box:read offline_access");
  const rbare = await newSilentContext(browser);
  const rtok = (await (await exchange(rbare, ro, rc.code, rc.verifier)).json()).access_token;
  await rbare.close();
  check("a read-only client can get box:read: the check above means something", Boolean(rc.code));
  check("box:read reads", (await raw(rtok, "/api/prefs")).status === 200);
  const rw = await raw(rtok, "/api/prefs", "PATCH");
  check("box:read cannot write", rw.status === 403, `${rw.status}`);
  const rg = await raw(rtok, "/api/fsrs/delete/nothing");
  check("box:read cannot use a GET that writes", rg.status === 403, `${rg.status}`);
  const dup = await owner.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data: { op: "add", origin: "http://127.0.0.1:3999", email: MEMBER, scopes: ["box:read"] },
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });
  check("one account cannot have a second box", dup.status() === 409, `${dup.status()}`);
  const notOwner = await newSilentContext(browser);
  await signUp(notOwner, MEMBER);
  const hidden = await notOwner.request.get(`${PROVIDER}/api/dev/box-clients`);
  check("the owner's route is 404 to anyone else", hidden.status() === 404, `${hidden.status()}`);
  await notOwner.close();
  await owner.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data: { op: "revoke", clientId: ro },
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });
  await owner.close();

  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
}

// ── The Li chat on the owner's box (box:chat, docs/box-oauth.md "Chat on the owner's box") ──
//
//   PROVIDER=… BOX=… OWNER=<site owner email> bun scripts/qa/qa-box-oauth.mjs chat-setup
//   … PUSH=http://127.0.0.1:<port> TICKET_KEY=<path to the JWK> bun … chat
//
// Three servers: the provider (its STT_TICKET_KEY = the JWK), lianki-push under
// `wrangler dev -c workers/push/wrangler.jsonc` (PARTNER_TICKET_PUB = its public
// half), and the box (LIANKI_BOX_HUB=ws://…PUSH/api/version/debug). The key is a
// throwaway made for the run. A peer socket (a partner ticket, signed here) stands
// in for the owner's other page. Silent: nothing speaks, the mic is never opened
// (the STT check posts a few bytes through the box's fetch).
//
// Local dev registry notes (2026-11-07): run the provider with a name of its own
// (`wrangler dev --name lianki-boxchat-qa`) and point lianki-push's MAIN/SESSIONS at
// it in a copy of its config, or another session's local `lianki` answers. The
// provider's PUSH notice (/internal/box-closed) got 503 from the local registry,
// so locally the hub's per-line check is what closes the socket; both are logged.

const owner = async (browser) => {
  const c = await newSilentContext(browser);
  await signUp(c, OWNER);
  return c;
};
const boxes = (ctx, data) =>
  ctx.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data,
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });

async function chatSetup() {
  const browser = await launchSilent(chromium);
  const ctx = await owner(browser);
  const m = await newSilentContext(browser);
  await signUp(m, MEMBER);
  await m.close();
  // A member's box can never get box:chat.
  const mb = await boxes(ctx, { op: "add", origin: BOX, email: MEMBER, scopes: ["box:read"] });
  const mid = (await mb.json()).clientId;
  const refused = await boxes(ctx, { op: "chat", clientId: mid, on: true });
  check("box:chat is refused for a member's box", refused.status() === 403, `${refused.status()}`);
  await boxes(ctx, { op: "revoke", clientId: mid });
  const ob = await boxes(ctx, {
    op: "add",
    origin: BOX,
    email: OWNER,
    scopes: ["box:read", "box:write"],
  });
  const body = await ob.json();
  if (!ob.ok()) throw new Error(`bind: ${ob.status()} ${JSON.stringify(body)}`);
  const granted = await boxes(ctx, { op: "chat", clientId: body.clientId, on: true });
  const row = (await granted.json()).boxes?.find((b) => b.clientId === body.clientId);
  check("box:chat is granted on the owner's box", granted.ok() && row?.scopes.includes("box:chat"));
  saveState({ clientId: body.clientId });
  console.log(`clientId=${body.clientId}`);
  await browser.close();
  if (failed) process.exit(1);
}

/** A socket in the owner's thread that is not the box: the owner's other page, as a partner ticket. */
async function peer(tag) {
  const { importTicketKey, signSttTicket, PARTNER_TICKET_AUD, PARTNER_SUBPROTOCOL } =
    await import("../../lib/stt-ticket.ts");
  const key = await importTicketKey(readFileSync(process.env.TICKET_KEY, "utf8"));
  const { ticket } = await signSttTicket(key, { aud: PARTNER_TICKET_AUD });
  const got = [];
  const ws = new WebSocket(`${PUSH_WS}/api/version/debug?label=qa-peer-${tag}`, {
    protocols: [PARTNER_SUBPROTOCOL, ticket],
    headers: { origin: "https://qa-peer.lianki.test" },
  });
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = () => no(new Error("peer socket refused"));
  });
  return {
    ws,
    got,
    say: (text) => ws.send(JSON.stringify({ type: "chat", id: crypto.randomUUID(), text })),
    heard: (text) =>
      got.find((m) => m.type === "chat" && m.message?.text === text)?.message ?? null,
  };
}

const PUSH_WS = (process.env.PUSH ?? "").replace(/^http/, "ws");
const wait = async (f, ms = 15_000) => {
  for (let t = 0; t < ms; t += 250) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};

/** A box chat ticket straight from the provider, as the box's token. */
const ticketFor = async (access) => {
  const r = await fetch(`${PROVIDER}/api/box/chat-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, origin: BOX },
  });
  return { status: r.status, ticket: r.ok ? (await r.json()).ticket : null };
};
/** Does lianki-push open a socket for this ticket from this origin? */
const opens = (ticket, origin) =>
  new Promise((done) => {
    const ws = new WebSocket(`${PUSH_WS}/api/version/debug?label=qa-probe`, {
      protocols: ["lianki-partner", ticket],
      headers: { origin },
    });
    ws.onopen = () => {
      ws.close();
      done(true);
    };
    ws.onerror = () => done(false);
  });

const chatText = (page) =>
  page.evaluate(() => document.querySelector("[data-debug-chat]")?.textContent ?? "");

async function chat() {
  const { clientId } = JSON.parse(readFileSync(STATE, "utf8"));
  const browser = await launchSilent(chromium);
  const ctx = await owner(browser);
  // Every socket's close code, in the page (4401 = the hub ended a box's chat).
  await ctx.addInitScript(() => {
    const Native = WebSocket;
    window.__qaCloses = [];
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        this.addEventListener("close", (e) => window.__qaCloses.push(e.code));
      }
    };
  });
  const run = Math.random().toString(36).slice(2, 8);
  const p = await peer(run);
  const before = `qa before ${run}`;
  p.say(before);
  await wait(() => p.heard(before));

  const page = await ctx.newPage();
  // The hub socket's traffic, by message type only, for a failure's detail.
  const frames = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/api/version/debug")) return;
    const kind = (dir) => (f) => {
      try {
        frames.push(`${dir}:${JSON.parse(String(f.payload)).type}`);
      } catch {
        frames.push(`${dir}:?`);
      }
    };
    ws.on("framesent", kind("out"));
    ws.on("framereceived", kind("in"));
    ws.on("close", () => frames.push("closed"));
  });
  await page.goto(`${BOX}/sign-in`);
  await page.waitForURL(`${BOX}/home**`, { timeout: 90_000 });
  await settled(page);
  await page.goto(`${BOX}/home?debug=1`);
  await settled(page);
  await page.waitForSelector("[data-debug-chat]", { timeout: 30_000 });
  check(
    "the chat loads on the box with the owner's history",
    Boolean(await wait(async () => (await chatText(page)).includes(before))),
  );
  check(
    "the box holds no cookie of lianki.com's session",
    !(await page.evaluate(() => document.cookie)).includes("session"),
  );

  const line = `qa from the box ${run}`;
  await page.fill('[data-testid="debug-chat-input"]', line);
  await page.keyboard.press("Enter");
  const posted = await wait(() => p.heard(line));
  check(
    "a line typed on the box reaches the owner's thread",
    Boolean(posted),
    posted ? "" : frames.slice(-12).join(" "),
  );
  check("labelled as the box", String(posted?.label ?? "").startsWith("box "), posted?.label);
  const reply = `qa reply ${run}`;
  p.say(reply);
  check(
    "a line in the owner's thread reaches the box",
    Boolean(await wait(async () => (await chatText(page)).includes(reply))),
  );

  const stt = await page.evaluate(async () => {
    const r = await fetch("/api/debug/stt", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(64),
    });
    return r.status;
  });
  check("the mic's STT route is open to box:chat", stt !== 403 && stt !== 404, `${stt}`);

  const access = JSON.parse(
    await page.evaluate(() => sessionStorage.getItem("lk:box:tokens")),
  ).access;
  const t1 = await ticketFor(access);
  check("a ticket is minted for the box's token", t1.status === 200 && Boolean(t1.ticket));
  check(
    "lianki-push refuses it from another box",
    !(await opens(t1.ticket, "https://my-0000000000000000.lianki.com")),
  );
  check(
    "and from lianki.com",
    !(await opens((await ticketFor(access)).ticket, "https://lianki.com")),
  );
  const t2 = (await ticketFor(access)).ticket;
  check("from its own box it opens once", await opens(t2, BOX));
  check("and never twice", !(await opens(t2, BOX)));
  const forged = await fetch(`${PROVIDER}/api/box/chat-ticket`, {
    method: "POST",
    headers: { origin: BOX, "x-lk-box-identity": "x.y.9999999999999.00" },
  });
  check("a forged identity gets no ticket", !forged.ok, `${forged.status}`);

  // Off on /dev/box-clients: the socket ends, and the routes close.
  const off = await boxes(ctx, { op: "chat", clientId, on: false });
  check("the owner turns box:chat off", off.ok(), `${off.status()}`);
  const ended = await wait(() => page.evaluate(() => window.__qaCloses.includes(4401)), 8_000);
  if (!ended) {
    // The notice is best effort; the hub's check on the next line must end it.
    await page.fill('[data-testid="debug-chat-input"]', `qa after off ${run}`);
    await page.keyboard.press("Enter");
  }
  check(
    `the box's socket is closed (${ended ? "notice" : "per-line check"})`,
    Boolean(ended || (await wait(() => page.evaluate(() => window.__qaCloses.includes(4401))))),
  );
  check("no line of it reaches the thread", !p.heard(`qa after off ${run}`));
  check("no ticket without box:chat", (await ticketFor(access)).status === 404);
  const sttOff = await page.evaluate(async () => {
    const r = await fetch("/api/debug/stt", { method: "POST", body: new Uint8Array(64) });
    return r.status;
  });
  check("nor the STT route", sttOff === 404, `${sttOff}`);

  // On again, then revoke: the same.
  await boxes(ctx, { op: "chat", clientId, on: true });
  await page.goto(`${BOX}/home?debug=1`);
  await settled(page);
  check(
    "on again, the chat is back",
    Boolean(await wait(async () => (await chatText(page)).includes(reply))),
  );
  await boxes(ctx, { op: "revoke", clientId });
  check(
    "revoke closes the box's socket",
    Boolean(await wait(() => page.evaluate(() => window.__qaCloses.includes(4401)), 8_000)) ||
      (await (async () => {
        await page.fill('[data-testid="debug-chat-input"]', `qa after revoke ${run}`);
        await page.keyboard.press("Enter");
        return Boolean(
          await wait(() => page.evaluate(() => window.__qaCloses.includes(4401)), 8_000),
        );
      })()),
  );
  check("and no ticket after it", (await ticketFor(access)).status === 401);

  p.ws.close();
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
}

// ── Code on the owner's box (box:eval, docs/box-oauth.md "Code on the owner's box") ──
//
//   PROVIDER=… BOX=… OWNER=… bun scripts/qa/qa-box-oauth.mjs code-setup
//   … PUSH=… TICKET_KEY=… bun … code
//
// The same three servers as `chat`. code-setup binds the owner's box and checks
// box:eval is refused for a member's box and before box:chat, then grants both.
// code: the box page shows the pairing of a sender (eval.ts's socket, from here),
// only its own Allow tap approves it, an eval by label reaches the box page and
// its result and page errors come back; turning box:eval off ends that while the
// chat goes on; revoke ends the rest. Silent: no audio, no mic.
//
// Local registry note (2026-11-07): start lianki-push only after the provider says
// "Ready"; one started first answered every SESSIONS call with "Worker … not found"
// although it listed the binding as connected (a restart of lianki-push fixed it).

async function evalSetup() {
  const browser = await launchSilent(chromium);
  const ctx = await owner(browser);
  const m = await newSilentContext(browser);
  await signUp(m, MEMBER);
  await m.close();
  const mb = await boxes(ctx, { op: "add", origin: BOX, email: MEMBER, scopes: ["box:read"] });
  const mid = (await mb.json()).clientId;
  const refused = await boxes(ctx, { op: "eval", clientId: mid, on: true });
  check("box:eval is refused for a member's box", refused.status() === 403, `${refused.status()}`);
  await boxes(ctx, { op: "revoke", clientId: mid });
  const ob = await boxes(ctx, {
    op: "add",
    origin: BOX,
    email: OWNER,
    scopes: ["box:read", "box:write"],
  });
  const body = await ob.json();
  if (!ob.ok()) throw new Error(`bind: ${ob.status()} ${JSON.stringify(body)}`);
  const early = await boxes(ctx, { op: "eval", clientId: body.clientId, on: true });
  check("box:eval needs box:chat first", early.status() === 409, `${early.status()}`);
  await boxes(ctx, { op: "chat", clientId: body.clientId, on: true });
  const chatRow = (
    await (await boxes(ctx, { op: "chat", clientId: body.clientId, on: true })).json()
  ).boxes?.find((b) => b.clientId === body.clientId);
  check("box:chat alone does not imply box:eval", !chatRow?.scopes.includes("box:eval"));
  const granted = await boxes(ctx, { op: "eval", clientId: body.clientId, on: true });
  const row = (await granted.json()).boxes?.find((b) => b.clientId === body.clientId);
  check("box:eval is granted on the owner's box", granted.ok() && row?.scopes.includes("box:eval"));
  saveState({ clientId: body.clientId });
  console.log(`clientId=${body.clientId}`);
  await browser.close();
  if (failed) process.exit(1);
}

/** eval.ts's side: an unauthenticated sender socket (no Origin), as the CLI opens it. */
async function sender(label) {
  const got = [];
  const ws = new WebSocket(`${PUSH_WS}/api/version/debug/control?label=${label}`);
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = () => no(new Error("sender socket refused"));
  });
  return {
    ws,
    got,
    send: (m) => ws.send(JSON.stringify(m)),
    last: (type) => got.filter((m) => m.type === type).at(-1) ?? null,
  };
}

async function evalRun() {
  const { clientId } = JSON.parse(readFileSync(STATE, "utf8"));
  const browser = await launchSilent(chromium);
  const ctx = await owner(browser);
  const run = Math.random().toString(36).slice(2, 8);
  const p = await peer(run);
  const page = await ctx.newPage();
  await page.goto(`${BOX}/sign-in`);
  await page.waitForURL(`${BOX}/home**`, { timeout: 90_000 });
  await settled(page);
  await page.goto(`${BOX}/home?debug=1`);
  await settled(page);
  await page.waitForSelector("[data-debug-chat]", { timeout: 30_000 });

  // A sender knocks: the box page is an owner page that can be asked.
  const s = await sender(`qa-box-eval-${run}`);
  const modal = await page
    .waitForSelector('[data-testid="debug-modal"]', { timeout: 15_000 })
    .catch(() => null);
  check("the pairing prompt shows on the box page", Boolean(modal));
  const code = await page.textContent('[data-testid="debug-modal-code"]').catch(() => "");
  check(
    "with the sender's code",
    Boolean(code) && JSON.stringify(s.got).includes(String(code).trim()),
  );
  check("nothing is approved before the tap", !s.last("approved"));
  // A line in the chat is no approval.
  p.say(`allow ${run}`);
  await new Promise((r) => setTimeout(r, 1000));
  check("a chat line does not approve it", !s.last("approved"));
  await page.click('[data-testid="debug-modal-allow"]');
  check(
    "the tap on the box page approves it (eval)",
    Boolean(await wait(() => s.last("approved")?.scope === "eval")),
    String(s.last("approved")?.scope ?? s.last("error")?.error ?? ""),
  );

  s.send({ type: "eval", code: "location.origin", target: "box" });
  const res = await wait(() => s.last("result"));
  const sent = s.last("sent");
  check(
    "an eval by label reaches the box page, and only the box",
    sent?.delivered >= 1 && sent.labels.every((l) => l.startsWith("box ")),
    `${sent?.delivered}`,
  );
  check(
    "and its result comes back",
    res?.ok === true && String(res?.value).includes(new URL(BOX).host),
    JSON.stringify(res),
  );
  check("labelled as the box", String(res?.page ?? "").startsWith("box "), res?.page);

  // A page error on the box reaches the agent.
  await page.evaluate(
    (r) =>
      setTimeout(() => {
        throw new Error(`qa box error ${r}`);
      }),
    run,
  );
  const err = await wait(() => s.got.find((m) => m.type === "page-error"));
  check("its page errors reach the agent", String(err?.message ?? "").includes(run), err?.message);

  // Off on /dev/box-clients: no more eval there; the chat goes on.
  const off = await boxes(ctx, { op: "eval", clientId, on: false });
  const row = (await off.json()).boxes?.find((b) => b.clientId === clientId);
  check(
    "the owner turns box:eval off, box:chat stays",
    off.ok() && row?.scopes.includes("box:chat") && !row?.scopes.includes("box:eval"),
  );
  await new Promise((r) => setTimeout(r, 1500));
  const before = s.got.filter((m) => m.type === "result").length;
  s.send({ type: "eval", code: "1+1", target: "box" });
  await wait(() => s.got.filter((m) => m.type === "sent").length >= 2, 8_000);
  check(
    "an eval is no longer delivered",
    s.last("sent")?.delivered === 0,
    JSON.stringify(s.last("sent")),
  );
  await new Promise((r) => setTimeout(r, 1000));
  check("and no result comes", s.got.filter((m) => m.type === "result").length === before);
  const line = `qa still chatting ${run}`;
  await page.fill('[data-testid="debug-chat-input"]', line);
  await page.keyboard.press("Enter");
  check("the chat still works", Boolean(await wait(() => p.heard(line))));

  // Back on, a reload, then revoke: everything ends.
  await boxes(ctx, { op: "eval", clientId, on: true });
  await boxes(ctx, { op: "revoke", clientId });
  s.send({ type: "eval", code: "2+2", target: "box" });
  await wait(() => s.got.filter((m) => m.type === "sent").length >= 3, 8_000);
  check(
    "after revoke nothing reaches the box",
    s.last("sent")?.delivered === 0,
    JSON.stringify(s.last("sent")),
  );

  s.ws.close();
  p.ws.close();
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
}

const cmd = process.argv[2];
await (cmd === "setup"
  ? setup()
  : cmd === "chat-setup"
    ? chatSetup()
    : cmd === "chat"
      ? chat()
      : cmd === "code-setup"
        ? evalSetup()
        : cmd === "code"
          ? evalRun()
          : run());
