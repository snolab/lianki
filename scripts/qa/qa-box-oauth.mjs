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
import { readFileSync, writeFileSync } from "node:fs";

const PROVIDER = process.env.PROVIDER;
const BOX = process.env.BOX;
const OWNER = process.env.OWNER;
const STATE = process.env.STATE ?? "/tmp/qa-box-oauth.json";
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
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const ctx = await browser.newContext();
  await signUp(ctx, OWNER);
  const member = await browser.newContext();
  await signUp(member, MEMBER);
  await member.close();
  const r = await ctx.request.post(`${PROVIDER}/api/dev/box-clients`, {
    data: { op: "add", origin: BOX, email: MEMBER, scopes: ["box:read", "box:write"] },
    headers: { origin: PROVIDER, "content-type": "application/json" },
  });
  const body = await r.json();
  if (!r.ok()) throw new Error(`bind: ${r.status()} ${JSON.stringify(body)}`);
  writeFileSync(STATE, JSON.stringify({ clientId: body.clientId }));
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

async function run() {
  const { clientId } = JSON.parse(readFileSync(STATE, "utf8"));
  const browser = await chromium.launch({ args: ["--mute-audio"] });

  // The bound member signs in at the provider, then opens the box.
  const ctx = await browser.newContext();
  await signUp(ctx, MEMBER);
  const page = await ctx.newPage();
  const cross = [];
  page.on("response", (r) => {
    if (r.url().startsWith(`${PROVIDER}/api/`)) cross.push(r);
  });
  await page.goto(`${BOX}/sign-in`);
  await page.waitForURL(`${BOX}/home**`, { timeout: 90_000 });
  check("sign-in on the box goes through the provider and comes back", true);
  check("the code is gone from the URL", !page.url().includes("code="));
  const stored = await page.evaluate(() => sessionStorage.getItem("lk:box:tokens") ?? "");
  const access = JSON.parse(stored || "{}").access ?? "";
  check("a box token is held", access.startsWith("lkb_"));

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
  const bare = await browser.newContext();
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
  const fresh = await browser.newContext();
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
  const other = await browser.newContext();
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

  // A box with no account gets the sign-in of lianki.com, not its own.
  const anon = await browser.newContext();
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
  const owner = await browser.newContext();
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
  const rbare = await browser.newContext();
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
  const notOwner = await browser.newContext();
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

await (process.argv[2] === "setup" ? setup() : run());
