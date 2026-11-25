#!/usr/bin/env bun
/**
 * OAuth sign-in for the remote MCP server (docs/mcp-oauth.md), end to end in a
 * real browser against the OpenNext Worker on LOCAL D1: the well-known
 * documents through the middleware, dynamic registration, the consent page and
 * its Allow click (Fetch Metadata from a real navigation), the code exchange
 * with PKCE, the token on an API route, and Disconnect in Preferences. The app's
 * redirect URI is a loopback address the browser never reaches: the request is
 * caught and read. Silent; phone size, light and dark screenshots.
 *
 *   QA_BASE=http://localhost:<port> bun scripts/qa/qa-mcp-oauth.mjs [outDir]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/mcp-oauth";
if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname))
  throw new Error(`qa-mcp-oauth flips a flag: local servers only, not ${BASE}`);
mkdirSync(OUT, { recursive: true });

const EMAIL = `qa+mcp-oauth-${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";
const REDIRECT = "http://127.0.0.1:47913/oauth/callback";
const VERIFIER = "qa-verifier-" + "x".repeat(40);

let failed = 0;
const check = (ok, name, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
};

const sql = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local d1: ${r.stderr}`);
};
const flag = (on) =>
  sql(
    `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('mcp.oauth', ${on ? 1 : 0}, '${new Date().toISOString()}', 'qa')`,
  );

async function s256(v) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Buffer.from(buf).toString("base64url");
}

/** Flags are cached up to 30 s per isolate: wait for the change, bounded. */
async function until(fn, ms = 40_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const prm = () => fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);

const browser = await launchSilent(chromium, { channel: "chromium" });
try {
  flag(false);
  check(await until(async () => (await prm()).status === 404), "flag off: metadata is 404");
  const off = await fetch(`${BASE}/api/mcp-oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  check(off.status === 404, "flag off: registration is 404");

  flag(true);
  check(await until(async () => (await prm()).status === 200), "flag on: metadata answers");
  const pr = await (await prm()).json();
  check(pr.resource === `${BASE}/mcp`, "protected resource names /mcp", pr.resource);
  const plain = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  check(plain.resource === pr.resource, "the root well-known path answers the same");
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check(
    as.issuer === BASE && as.code_challenge_methods_supported?.includes("S256"),
    "authorization server metadata: issuer and S256",
  );

  const reg = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "QA Assistant",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = await reg.json();
  check(reg.status === 201 && client.client_id.startsWith("lkc_"), "dynamic registration");

  const signup = await newSilentContext(browser, {});
  const su = await signup.request.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE, "content-type": "application/json" },
    data: { email: EMAIL, password: PW, name: "QA" },
  });
  check(su.ok(), "the QA account signs up");
  await signup.close();

  const query = async (state) =>
    new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: await s256(VERIFIER),
      code_challenge_method: "S256",
      state,
      scope: "study chat:read",
      resource: `${BASE}/mcp`,
    });

  // Signed out: to /sign-in, with the way back.
  const guest = await newSilentContext(browser, {});
  const gp = await guest.newPage();
  await gp.route("http://127.0.0.1:47913/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }),
  );
  await gp.goto(`${as.authorization_endpoint}?${await query("s0")}`);
  const gu = new URL(gp.url());
  check(
    gu.pathname === "/sign-in" &&
      (gu.searchParams.get("next") ?? "").startsWith("/my/connected-apps/new?"),
    "signed out: sent to sign in, with the consent page to come back to",
    gp.url(),
  );
  await guest.close();

  let n = 0;
  for (const [tag, colorScheme] of [
    ["light", "light"],
    ["dark", "dark"],
  ]) {
    const ctx = await newSilentContext(browser, { ...devices["iPhone 13"], colorScheme });
    const page = await ctx.newPage();
    const si = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
      headers: { origin: BASE, "content-type": "application/json" },
      data: { email: EMAIL, password: PW },
    });
    check(si.ok(), `${tag}: signed in`);
    let landed = null;
    await page.route("http://127.0.0.1:47913/**", (route) => {
      landed = route.request().url();
      return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
    });
    const state = `s${++n}`;
    await page.goto(`${as.authorization_endpoint}?${await query(state)}`);
    const name = await page.getByTestId("connect-app-name").textContent();
    check(name === "QA Assistant", `${tag}: consent names the app`);
    check(
      (await page.getByTestId("connect-app-host").textContent())?.includes("127.0.0.1:47913"),
      `${tag}: consent names where it returns`,
    );
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    check(wide, `${tag}: no sideways scroll`);
    await page.screenshot({ path: join(OUT, `consent-${tag}.png`), fullPage: true });
    await page.getByTestId("connect-app-allow").click();
    await until(async () => landed !== null, 10_000);
    const back = landed ? new URL(landed) : null;
    const code = back?.searchParams.get("code");
    check(
      !!code && back.searchParams.get("state") === state && back.searchParams.get("iss") === BASE,
      `${tag}: Allow returns a code, the state and iss`,
    );

    const exchange = (verifier) =>
      fetch(as.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: `${BASE}/mcp`,
        }),
      });
    if (tag === "light") {
      const bad = await exchange("y".repeat(43));
      check(bad.status === 400, "a wrong PKCE verifier is refused (and the code is spent)");
      const spent = await exchange(VERIFIER);
      check(spent.status === 400, "the spent code no longer works");
      await ctx.close();
      continue;
    }
    const tok = await exchange(VERIFIER);
    const t = await tok.json();
    check(tok.status === 200 && t.access_token.startsWith("lk_"), "the code buys an lk_ token");
    const me = await fetch(`${BASE}/api/cli-login/token`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    const meBody = await me.json();
    check(
      me.status === 200 && meBody.scopes?.join(" ") === "study chat:read",
      "the API checks it as any API token",
    );

    await page.goto(`${BASE}/my/preferences#tokens`);
    const row = page.getByTestId("connected-app-row");
    await row.first().waitFor({ timeout: 15_000 });
    check((await row.count()) === 1, "Preferences lists the connected app");
    await page.getByTestId("connected-apps").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, `connected-${tag}.png`) });
    await row.first().getByTestId("token-revoke").click();
    await row.first().getByTestId("token-revoke-yes").click();
    await until(async () => (await page.getByTestId("connected-app-row").count()) === 0, 10_000);
    const after = await fetch(`${BASE}/api/cli-login/token`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    check(after.status === 401, "after Disconnect the token is refused");
    await ctx.close();
  }
} finally {
  try {
    flag(false);
  } catch (e) {
    console.error("could not turn mcp.oauth back off", e);
    failed++;
  }
  await browser.close();
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("qa-mcp-oauth: all passed");
