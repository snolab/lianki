#!/usr/bin/env bun
/**
 * End to end for a box signing in through lianki.com (docs/box-oauth.md), in a
 * real browser against the real provider code: the OpenNext Worker under
 * `wrangler dev` on local D1 as lianki.com, and a second, separate `next dev`
 * as the box on another origin. Nothing leaves this machine.
 *
 *   PROVIDER=http://localhost:<port> BOX=http://localhost:<port> OWNER=<email> \
 *     bun scripts/qa/qa-box-oauth.mjs setup     # prints the client id for the box's env
 *   … bun scripts/qa/qa-box-oauth.mjs run
 *
 * The provider needs DEV_EMAIL_PASSWORD_AUTH=1 and the flag on in its local D1.
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
  check(
    "the page's /api call reaches the provider as this account",
    prefs.status === 200,
    `${prefs.status}`,
  );
  const put = await pageApi(page, "/api/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: {} }),
  });
  check(
    "a write with box:write gets past the gate to the route",
    put.status !== 401 && put.status !== 403 && put.status !== 404,
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
  const after = await direct("/api/prefs").catch(() => ({ status: 0 }));
  check("its token stops at once", after.status !== 200, `${after.status}`);
  await owner.close();

  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
}

await (process.argv[2] === "setup" ? setup() : run());
