/**
 * my-<hash> boxes signing in through lianki.com (lib/box-oauth, docs/box-oauth.md).
 * What matters: the flag off changes nothing; a token works only from its own
 * box, as its bound account, on allowlisted routes, within its scope; no route
 * of account, admin or payment reach; credentials stay off; a revoke ends it;
 * the app never sees a token or a cookie.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { FLAGS } from "@/lib/flags";
import { customFrontendBlocked } from "@/lib/live-view/page-proxy";
import { boxApiUrl } from "@/lib/box-oauth/client";
import { boxGate, boxTokenHash, mayBeBox, sha256B64Url, type GateDeps } from "@/lib/box-oauth/gate";
import { BOX_IDENTITY_HEADER, signBoxIdentity, verifyBoxIdentity } from "@/lib/box-oauth/identity";
import {
  BOX_FLAG,
  authPathOf,
  cleanAuthorizeQuery,
  BOX_RESERVED_NAMES,
  isBoxHost,
  isBoxOrigin,
  isFirstPartyNavigation,
  isMutatingGet,
  isOpenProviderPath,
  isProviderPath,
  parseScopes,
  tokenMayCall,
} from "@/lib/box-oauth/rules";
import {
  bindingByClient,
  bindingByOrigin,
  boxUser,
  insertBinding,
  listBindings,
  liveToken,
  revokeBox,
  validNewBox,
  type BoxDb,
} from "@/lib/box-oauth/store";
import { hasSessionCookie } from "@/lib/auth-env";
import { signInReturnPath } from "@/lib/dev-server-switch";

const ORIGIN = "https://my-0123456789abcdef.lianki.com";
const OTHER = "https://my-fedcba9876543210.lianki.com";
/** A made-up named box: the form is what is tested, never a real box's name. */
const NAMED = "https://my-example.lianki.com";
const SECRET = "x".repeat(40);
const TOKEN = `lkb_${"a".repeat(32)}`;
const RW = ["box:read", "box:write"];

describe("origins", () => {
  test("only my-<hash>.lianki.com or my-<name>.lianki.com, exactly", () => {
    expect(isBoxOrigin(ORIGIN)).toBe(true);
    expect(isBoxOrigin(NAMED)).toBe(true);
    for (const o of [
      "https://my-ab.lianki.com",
      "https://my-example.lianki.com.evil.com",
      "https://my-example.lianki.com/",
      "https://my-example.lianki.com:443",
      "http://my-example.lianki.com",
      "https://my-admin.lianki.com",
      "https://MY-EXAMPLE.lianki.com",
      "http://my-0123456789abcdef.lianki.com",
      "https://my-0123456789abcdef.lianki.com.evil.test",
      "https://evil.test/my-0123456789abcdef.lianki.com",
      "https://x.my-0123456789abcdef.lianki.com",
      "https://MY-0123456789ABCDEF.lianki.com",
      "https://lianki.com",
      "http://localhost:3000",
      "null",
      "",
      null,
    ])
      expect(isBoxOrigin(o)).toBe(false);
  });
  test("127.0.0.1 only on a dev server", () => {
    expect(isBoxOrigin("http://127.0.0.1:3201", true)).toBe(true);
    expect(isBoxOrigin("http://localhost:3201", true)).toBe(false);
    expect(isBoxOrigin("http://evil.test:3201", true)).toBe(false);
  });
});

describe("box hosts", () => {
  test("the hex form, 12 to 64 lowercase hex", () => {
    for (const h of ["0123456789ab", "0123456789abcdef", "a".repeat(64)])
      expect(isBoxHost(`my-${h}.lianki.com`)).toBe(true);
    for (const h of ["a".repeat(65), "0123456789ABCDEF"])
      expect(isBoxHost(`my-${h}.lianki.com`)).toBe(false);
  });

  test("the named form: 3 to 30 of a-z, 0-9, inner single hyphens", () => {
    for (const n of ["example", "abc", "a1b", "my-team-2", "x".repeat(30), "123"])
      expect(isBoxHost(`my-${n}.lianki.com`)).toBe(true);
    for (const n of [
      "ab",
      "x".repeat(31),
      "-example",
      "example-",
      "ex--ample",
      "ex_ample",
      "ex.ample",
      "Example",
      "EXAMPLE",
      "exämple",
      "ex ample",
      "",
    ])
      expect(isBoxHost(`my-${n}.lianki.com`)).toBe(false);
  });

  test("reserved names are refused, whatever their shape", () => {
    for (const n of ["admin", "api", "www"]) expect(BOX_RESERVED_NAMES).toContain(n);
    for (const n of BOX_RESERVED_NAMES) expect(isBoxHost(`my-${n}.lianki.com`)).toBe(false);
  });

  test("look-alikes, other parents, punycode and other levels are not boxes", () => {
    for (const h of [
      "my-example.lianki.com.evil.com",
      "my-example.lianki.co",
      "my-example.lianki.com.",
      "my-example.evil-lianki.com",
      "my-examplelianki.com",
      "x.my-example.lianki.com",
      "my-example.x.lianki.com",
      "xn--my-exmple-cua.lianki.com",
      "my-xn--exmple-cua.lianki.com",
      "my-example.xn--lianki-com.com",
      "my-.lianki.com",
      "my.lianki.com",
      "example.lianki.com",
      "lianki.com",
      " my-example.lianki.com",
      "my-example.lianki.com\n",
      "",
      null,
      undefined,
    ])
      expect(isBoxHost(h)).toBe(false);
  });

  test("the URL parser's own form of a Unicode host is not a box", () => {
    const host = new URL("https://my-exämple.lianki.com").hostname;
    expect(host.startsWith("xn--")).toBe(true);
    expect(isBoxHost(host)).toBe(false);
  });
});

describe("the route allowlist", () => {
  test("own study data is reachable", () => {
    for (const p of ["/api/fsrs/next", "/api/words/lists", "/api/read/abc", "/api/prefs"])
      expect(tokenMayCall("GET", p, RW)).toEqual({ ok: true });
    expect(tokenMayCall("POST", "/api/prefs", RW)).toEqual({ ok: true });
  });

  test("anything not listed is closed: admin, owner, payments, tokens, keys, login", () => {
    for (const p of [
      "/api/dev/flags",
      "/api/dev/box-clients",
      "/api/dev-access/verify",
      "/api/dev-whole-page/login",
      "/api/debug/identity",
      "/api/debug/stt",
      "/api/payments/checkout",
      "/api/gift-codes/redeem",
      "/api/byok/proxy",
      "/api/profile/email",
      "/api/profile/email/confirm",
      "/api/invite",
      "/api/token",
      "/api/cli-login/token",
      "/api/live-previews",
      "/api/live-view",
      "/api/connections/google",
      "/api/slack/events",
      "/api/contact",
      "/api/self-intro/import",
      "/api/export/yaml",
      "/api/import/yaml",
      "/api/auth/update-user",
      "/api/auth/change-email",
      "/api/auth/get-session",
      "/api/auth/oauth2/token",
      "/api/not-a-route-yet",
      "/api/prefsX",
      "/home",
    ])
      for (const m of ["GET", "POST", "DELETE"])
        expect({ p, m, r: tokenMayCall(m, p, RW).ok }).toEqual({ p, m, r: false });
  });

  test("every account write a custom frontend may not make is closed here too", () => {
    for (const p of [
      "/api/token",
      "/api/cli-login/approve",
      "/api/live-previews",
      "/api/live-view",
      "/api/dev/flags",
      "/api/dev-access/verify",
      "/api/auth/update-user",
      "/api/auth/delete-user",
      "/api/auth/link-social",
      "/api/auth/revoke-sessions",
      "/api/auth/passkey/add",
    ]) {
      expect(customFrontendBlocked("POST", p)).toBe(true);
      expect(tokenMayCall("POST", p, RW).ok).toBe(false);
    }
  });

  test("a path dressed up to mean something else is closed", () => {
    for (const p of [
      "/api/fsrs/../dev/flags",
      "/api/fsrs/%2e%2e/dev/flags",
      "/api/%64ev/flags",
      "/api/fsrs//next",
      "/api/fsrs\\next",
      "/API/DEV/FLAGS",
      "/api/fsrs/./next",
    ])
      expect({ p, r: tokenMayCall("GET", p, RW).ok }).toEqual({ p, r: false });
  });

  test("a Google Docs read stays closed: it needs the account's Drive connection", () => {
    expect(tokenMayCall("GET", "/api/read/gdoc", RW).ok).toBe(false);
  });

  test("read-only routes take no writes, even with box:write", () => {
    expect(tokenMayCall("GET", "/api/membership/status", RW).ok).toBe(true);
    expect(tokenMayCall("POST", "/api/membership/status", RW).ok).toBe(false);
  });

  test("box:read cannot write, including the GETs that write", () => {
    const read = ["box:read"];
    expect(tokenMayCall("GET", "/api/fsrs/next", read)).toEqual({ ok: true });
    expect(tokenMayCall("POST", "/api/prefs", read)).toMatchObject({ ok: false, reason: "scope" });
    for (const p of ["/api/fsrs/review/1", "/api/fsrs/delete", "/api/fsrs/repeat"]) {
      expect(isMutatingGet(p)).toBe(true);
      expect(tokenMayCall("GET", p, read)).toMatchObject({ ok: false, reason: "scope" });
      expect(tokenMayCall("GET", p, RW)).toEqual({ ok: true });
    }
    expect(tokenMayCall("GET", "/api/fsrs/next", [])).toMatchObject({ ok: false });
  });

  test("odd methods are refused", () => {
    for (const m of ["OPTIONS", "TRACE", "CONNECT"])
      expect(tokenMayCall(m, "/api/fsrs/next", RW).ok).toBe(false);
  });
});

describe("the plugin's routes", () => {
  test("only authorize, token and revoke are open", () => {
    for (const p of ["/oauth2/authorize", "/oauth2/token", "/oauth2/revoke"])
      expect([isProviderPath(p), isOpenProviderPath(p)]).toEqual([true, true]);
    for (const p of [
      "/oauth2/create-client",
      "/oauth2/register",
      "/oauth2/get-clients",
      "/oauth2/delete-client",
      "/oauth2/update-client",
      "/oauth2/client/rotate-secret",
      "/oauth2/consent",
      "/oauth2/continue",
      "/oauth2/get-consents",
      "/oauth2/introspect",
      "/oauth2/userinfo",
      "/oauth2/end-session",
      "/admin/oauth2/create-client",
      "/admin/oauth2/resources",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/oauth2/token/",
      "/OAUTH2/create-client",
    ])
      expect([p, isProviderPath(p), isOpenProviderPath(p)]).toEqual([p, true, false]);
  });
  test("better-auth's own routes are not touched", () => {
    for (const p of ["/get-session", "/sign-out", "/sign-in/email-otp", "/passkey/add-passkey"])
      expect(isProviderPath(p)).toBe(false);
    expect(authPathOf("/api/auth/oauth2/token")).toBe("/oauth2/token");
  });
});

describe("the signed identity", () => {
  const who = { userId: "u.1/x", clientId: "c1" };
  test("round trip", async () => {
    expect(await verifyBoxIdentity(SECRET, await signBoxIdentity(SECRET, who))).toEqual(who);
  });
  test("altered, unsigned, expired or wrong key is nobody", async () => {
    const good = await signBoxIdentity(SECRET, who, 1000);
    expect(await verifyBoxIdentity(SECRET, good, 1000)).toEqual(who);
    expect(await verifyBoxIdentity(SECRET, good, 1000 + 61_000)).toBeNull();
    expect(await verifyBoxIdentity("y".repeat(40), good, 1000)).toBeNull();
    expect(await verifyBoxIdentity(SECRET, good.replace("u%2E1", "u%2E2"), 1000)).toBeNull();
    expect(await verifyBoxIdentity(SECRET, "owner", 1000)).toBeNull();
    expect(await verifyBoxIdentity(undefined, good, 1000)).toBeNull();
    expect(await verifyBoxIdentity("short", good, 1000)).toBeNull();
    expect(await verifyBoxIdentity(SECRET, null)).toBeNull();
  });
  test("counts as a session for the cookie-free fast path, and only then", () => {
    expect(hasSessionCookie(new Headers({ [BOX_IDENTITY_HEADER]: "x" }))).toBe(true);
    expect(hasSessionCookie(new Headers())).toBe(false);
  });
  test("on a box there is no session at all, cookie or not", () => {
    process.env.LIANKI_BOX_CLIENT_ID = "c1";
    try {
      expect(hasSessionCookie(new Headers({ cookie: "better-auth.session_token=x" }))).toBe(false);
      expect(hasSessionCookie(new Headers({ [BOX_IDENTITY_HEADER]: "x" }))).toBe(false);
    } finally {
      delete process.env.LIANKI_BOX_CLIENT_ID;
    }
    expect(hasSessionCookie(new Headers({ cookie: "better-auth.session_token=x" }))).toBe(true);
  });
});

describe("what may start the plugin's authorize", () => {
  const nav = {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-site": "same-origin",
  };
  const ok = (o: Record<string, string>) => isFirstPartyNavigation(new Headers(o));
  test("only lianki.com's own top-level navigation", () => {
    expect(ok(nav)).toBe(true);
  });
  test("a fetch from a page on lianki.com cannot read a code", () => {
    expect(ok({ ...nav, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).toBe(false);
  });
  test("nor a frame, a sibling's navigation, or a client with no such headers", () => {
    expect(ok({ ...nav, "sec-fetch-dest": "iframe" })).toBe(false);
    expect(ok({ ...nav, "sec-fetch-site": "same-site" })).toBe(false);
    expect(ok({ ...nav, "sec-fetch-site": "cross-site" })).toBe(false);
    expect(ok({})).toBe(false);
  });
});

describe("the sign-in return path", () => {
  const q =
    "response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fmy-0123456789abcdef.lianki.com%2Fbox-callback&scope=box%3Aread&state=s&code_challenge=x&code_challenge_method=S256";
  test("the entry comes back rebuilt", () => {
    expect(signInReturnPath(`/box-authorize?${q}&extra=1`)).toBe(`/box-authorize?${q}`);
  });
  test("nothing else opens up", () => {
    expect(signInReturnPath("/box-authorize?client_id=c")).toBeNull();
    expect(signInReturnPath(`//evil.test/box-authorize?${q}`)).toBeNull();
    expect(signInReturnPath(`/box-other?${q}`)).toBeNull();
  });
  test("PKCE S256 is required", () => {
    const p = new URLSearchParams(q);
    p.set("code_challenge_method", "plain");
    expect(cleanAuthorizeQuery(p)).toBeNull();
    p.set("code_challenge_method", "S256");
    p.delete("code_challenge");
    expect(cleanAuthorizeQuery(p)).toBeNull();
  });
});

describe("the box's fetch", () => {
  const here = `${ORIGIN}/words`;
  test("only same-origin /api, never /api/auth", () => {
    expect(boxApiUrl("/api/fsrs/next?x=1", here)).toBe("/api/fsrs/next?x=1");
    expect(boxApiUrl(`${ORIGIN}/api/prefs`, here)).toBe("/api/prefs");
    expect(boxApiUrl("/api/auth/get-session", here)).toBeNull();
    expect(boxApiUrl("/_next/x.js", here)).toBeNull();
    expect(boxApiUrl("https://evil.test/api/prefs", here)).toBeNull();
  });
});

describe("scopes and new boxes", () => {
  test("parseScopes reads either store format", () => {
    expect(parseScopes('["box:read","offline_access"]')).toEqual(["box:read", "offline_access"]);
    expect(parseScopes("box:read box:write")).toEqual(["box:read", "box:write"]);
    expect(parseScopes("[broken")).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
  });
  test("validNewBox", () => {
    expect(validNewBox(ORIGIN, ["box:read"], false)).toBeNull();
    expect(validNewBox(NAMED, ["box:read"], false)).toBeNull();
    expect(validNewBox("https://my-www.lianki.com", ["box:read"], false)).not.toBeNull();
    expect(validNewBox("https://evil.test", ["box:read"], false)).not.toBeNull();
    expect(validNewBox(ORIGIN, [], false)).not.toBeNull();
    expect(validNewBox(ORIGIN, ["admin"], false)).not.toBeNull();
    expect(validNewBox("http://127.0.0.1:3201", ["box:read"], false)).not.toBeNull();
  });
  test("the flag ships off", () => {
    expect(FLAGS[BOX_FLAG].default).toBe(false);
  });
});

/** A D1 with the tables the gate reads, from the real migration. */
async function setup() {
  const db: TestD1Database = createTestD1(testSchema());
  const now = "2026-11-05T00:00:00.000Z";
  for (const id of ["u1", "u2"])
    await db
      .prepare(
        "INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES (?1, ?2, ?1, 1, ?3, ?3)",
      )
      .bind(id, `${id}@test.example`, now)
      .run();
  await db
    .prepare(
      "INSERT INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES ('c1', 'c1', '[]', ?1, ?1)",
    )
    .bind(now)
    .run();
  return db;
}

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

async function addToken(
  db: TestD1Database,
  opts: { user?: string; scopes?: string; expires?: number } = {},
) {
  await db
    .prepare(
      "INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES ('t1', ?1, 'c1', ?2, ?3, ?4, ?5)",
    )
    .bind(
      await boxTokenHash(TOKEN),
      opts.user ?? "u1",
      new Date(opts.expires ?? NOW + 60_000).toISOString(),
      new Date(NOW).toISOString(),
      opts.scopes ?? '["box:read","box:write"]',
    )
    .run();
}

describe("the GETs that write", () => {
  test("the same list as app/fsrs.ts: a new one there must be closed to box:read too", () => {
    const src = readFileSync("app/fsrs.ts", "utf8");
    const there = /function isMutatingGet[^]*?return (\/.*?\/i)\.test/.exec(src)?.[1];
    expect(there).toBe(String(isMutatingGet).match(/return (\/.*?\/i)\.test/)?.[1]);
  });
});

describe("the token hash", () => {
  test("is the plugin's: base64url SHA-256 of the value without its prefix", async () => {
    // Pinned to the plugin (authorize-*.mjs strips opts.prefix before hashing). If an
    // upgrade changes this, every token is refused; qa-box-oauth.mjs catches that too.
    expect(await boxTokenHash("lkb_abc")).toBe(await sha256B64Url("abc"));
    expect(await sha256B64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});

describe("the store", () => {
  let db: TestD1Database;
  beforeEach(async () => {
    db = await setup();
  });
  const box = () => db as unknown as BoxDb;
  const bind = (over: Partial<{ clientId: string; origin: string; userId: string }> = {}) =>
    insertBinding(
      box(),
      { clientId: "c1", origin: ORIGIN, userId: "u1", scopes: RW, ...over },
      "owner",
      NOW,
    );

  test("one account has one box, one box has one account", async () => {
    expect(await bind()).toBe(true);
    expect(await bind({ clientId: "c2", origin: OTHER })).toBe(false);
    expect(await bind({ clientId: "c3", userId: "u2" })).toBe(false);
    expect(await bind({ clientId: "c4", origin: OTHER, userId: "u2" })).toBe(true);
  });

  test("a token of another account than the bound one is no token", async () => {
    await bind();
    await addToken(db, { user: "u2" });
    expect(await liveToken(box(), await boxTokenHash(TOKEN), NOW)).toBeNull();
  });

  test("never more scope than the owner granted", async () => {
    await insertBinding(
      box(),
      { clientId: "c1", origin: ORIGIN, userId: "u1", scopes: ["box:read"] },
      "owner",
      NOW,
    );
    await addToken(db);
    expect((await liveToken(box(), await boxTokenHash(TOKEN), NOW))?.scopes).toEqual(["box:read"]);
  });

  test("expired is no token", async () => {
    await bind();
    await addToken(db, { expires: NOW - 1 });
    expect(await liveToken(box(), await boxTokenHash(TOKEN), NOW)).toBeNull();
  });

  test("revoke ends the box and every token, once, and is audited", async () => {
    await bind();
    await addToken(db);
    const hash = await boxTokenHash(TOKEN);
    expect(await liveToken(box(), hash, NOW)).not.toBeNull();
    expect(await revokeBox(box(), "c1", "owner", NOW)).toBe(true);
    expect(await liveToken(box(), hash, NOW)).toBeNull();
    expect(await bindingByOrigin(box(), ORIGIN)).toBeNull();
    expect(await revokeBox(box(), "c1", "owner", NOW)).toBe(false);
    const row = await db
      .prepare("SELECT disabled FROM oauthClient WHERE clientId = 'c1'")
      .first<{ disabled: number }>();
    expect(row?.disabled).toBe(1);
    const t = await db
      .prepare("SELECT revoked FROM oauthAccessToken WHERE id = 't1'")
      .first<{ revoked: string }>();
    expect(t?.revoked).toBeTruthy();
    const { results } = await db
      .prepare("SELECT kind FROM security_audit WHERE kind LIKE 'box.%' ORDER BY id")
      .all<{ kind: string }>();
    expect(results.map((r) => r.kind)).toEqual(["box.bind", "box.revoke"]);
  });

  test("the owner's list: the account's email, live ones first", async () => {
    await bind();
    await revokeBox(box(), "c1", "owner", NOW);
    await bind({ clientId: "c2", origin: OTHER, userId: "u2" });
    const list = await listBindings(box());
    expect(list.map((b) => [b.clientId, b.email, b.revokedAt !== null])).toEqual([
      ["c2", "u2@test.example", false],
      ["c1", "u1@test.example", true],
    ]);
    expect(list[0].scopes).toEqual(RW);
    expect(await bindingByClient(box(), "c1")).toBeNull();
    expect((await bindingByClient(box(), "c2"))?.origin).toBe(OTHER);
  });

  test("revoking an unknown box changes nothing", async () => {
    expect(await revokeBox(box(), "nobody", "owner", NOW)).toBe(false);
  });

  test("revoke works on a database with no batch", async () => {
    await bind();
    await addToken(db);
    const plain = { prepare: (sql: string) => db.prepare(sql) } as unknown as BoxDb;
    expect(await revokeBox(plain, "c1", "owner", NOW)).toBe(true);
    expect(await liveToken(box(), await boxTokenHash(TOKEN), NOW)).toBeNull();
  });

  test("the user the app sees", async () => {
    expect((await boxUser(box(), "u1"))?.email).toBe("u1@test.example");
    expect(await boxUser(box(), "nobody")).toBeNull();
  });

  test("after a revoke the origin and the account can be bound again", async () => {
    await bind();
    await revokeBox(box(), "c1", "owner", NOW);
    expect(await bind({ clientId: "c2" })).toBe(true);
  });
});

describe("the gate", () => {
  let db: TestD1Database;
  let flag: boolean;
  let allowed: boolean;
  let seen: Request | null;
  const deps: GateDeps = {
    flagOn: async () => flag,
    allow: async () => allowed,
    now: () => NOW,
  };
  const env = () => ({ DB: db as unknown as BoxDb, AUTH_SECRET: SECRET });
  const app = async (r: Request) => {
    seen = r;
    const res = new Response("from app", { status: 200 });
    res.headers.append("set-cookie", "better-auth.session_token=stolen");
    return res;
  };
  const call = (path: string, init: RequestInit = {}) =>
    boxGate(new Request(`https://lianki.com${path}`, init), env(), deps, app);
  const tokenHeaders = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${TOKEN}`,
    origin: ORIGIN,
    ...extra,
  });

  beforeEach(async () => {
    db = await setup();
    flag = true;
    allowed = true;
    seen = null;
    await insertBinding(
      db as unknown as BoxDb,
      { clientId: "c1", origin: ORIGIN, userId: "u1", scopes: RW },
      "owner",
      NOW,
    );
    await addToken(db);
  });

  test("an ordinary request goes straight on, untouched", async () => {
    const req = new Request("https://lianki.com/api/prefs", { headers: { cookie: "a=b" } });
    expect(mayBeBox(req)).toBe(false);
    await boxGate(req, env(), deps, app);
    expect(seen).toBe(req);
  });

  test("nobody can send the identity header from outside", async () => {
    await call("/api/prefs", { headers: { [BOX_IDENTITY_HEADER]: "forged" } });
    expect(seen?.headers.has(BOX_IDENTITY_HEADER)).toBe(false);
  });

  describe("flag off", () => {
    beforeEach(() => {
      flag = false;
    });
    test("a token gets 404 and reaches nothing", async () => {
      expect((await call("/api/prefs", { headers: tokenHeaders() })).status).toBe(404);
      expect(seen).toBeNull();
    });
    test("no CORS answer for a box origin", async () => {
      const res = await call("/api/prefs", { method: "OPTIONS", headers: { origin: ORIGIN } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(seen).not.toBeNull();
    });
  });

  test("the app gets the identity and no token, no cookie; no cookie comes back", async () => {
    const res = await call("/api/prefs", { headers: tokenHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen?.headers.get("authorization")).toBeNull();
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(seen?.headers.get("origin")).toBe("https://lianki.com");
    expect(seen?.headers.get("sec-fetch-site")).toBeNull();
    expect(await verifyBoxIdentity(SECRET, seen?.headers.get(BOX_IDENTITY_HEADER), NOW)).toEqual({
      userId: "u1",
      clientId: "c1",
    });
  });

  test("a token and a cookie together are refused, and no CORS is granted", async () => {
    const res = await call("/api/prefs", {
      headers: tokenHeaders({ cookie: "better-auth.session_token=x" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toBeNull();
  });

  test("a token from another origin, or none, is refused", async () => {
    for (const headers of [
      tokenHeaders({ origin: OTHER }),
      { authorization: `Bearer ${TOKEN}` },
      tokenHeaders({ origin: "https://evil.test" }),
    ]) {
      const res = await call("/api/prefs", { headers });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(seen).toBeNull();
  });

  test("an unknown or malformed token never falls back", async () => {
    for (const bearer of [
      `Bearer lkb_${"b".repeat(32)}`,
      "Bearer lkb_short",
      "Bearer lkb_!!!!!!!!!!!!!!!!!!!!",
    ]) {
      const res = await call("/api/prefs", { headers: tokenHeaders({ authorization: bearer }) });
      expect(res.status).toBe(401);
    }
    expect(seen).toBeNull();
  });

  test("off the allowlist is closed for a valid token", async () => {
    expect((await call("/api/dev/flags", { headers: tokenHeaders() })).status).toBe(404);
    expect((await call("/api/token", { method: "POST", headers: tokenHeaders() })).status).toBe(
      404,
    );
    expect(seen).toBeNull();
  });

  test("on a dev server, its own pages are not a box", async () => {
    const res = await boxGate(
      new Request("http://127.0.0.1:3911/api/dev/box-clients", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3911", cookie: "better-auth.session_token=x" },
      }),
      { ...env(), NODE_ENV: "development" },
      deps,
      app,
    );
    expect(res.status).toBe(200);
    expect(seen?.headers.get("cookie")).toContain("session_token");
  });

  test("the budget runs out per token", async () => {
    allowed = false;
    const res = await call("/api/prefs", { headers: tokenHeaders() });
    expect(res.status).toBe(429);
    expect(seen).toBeNull();
  });

  test("a revoked box stops at once", async () => {
    await revokeBox(db as unknown as BoxDb, "c1", "owner", NOW);
    expect((await call("/api/prefs", { headers: tokenHeaders() })).status).toBe(401);
  });

  test("preflight: exact origin, no credentials; an unknown box gets nothing", async () => {
    const ok = await call("/api/prefs", { method: "OPTIONS", headers: { origin: ORIGIN } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(ok.headers.get("vary")).toContain("Origin");
    const no = await call("/api/prefs", { method: "OPTIONS", headers: { origin: OTHER } });
    expect(no.status).toBe(403);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  describe("a named box host", () => {
    const named = (over: Record<string, string> = {}) => tokenHeaders({ origin: NAMED, ...over });

    test("unbound, it gets nothing: no CORS, no token use, no code exchange", async () => {
      const pre = await call("/api/prefs", { method: "OPTIONS", headers: { origin: NAMED } });
      expect(pre.status).toBe(403);
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
      const res = await call("/api/prefs", { headers: named() });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      const code = await call("/api/auth/oauth2/token", {
        method: "POST",
        headers: { origin: NAMED },
        body: "grant_type=x",
      });
      expect(code.status).toBe(403);
      expect(seen).toBeNull();
    });

    test("bound, it works like a hex box, and only from its own origin", async () => {
      const named2 = await setup();
      db = named2;
      await insertBinding(
        db as unknown as BoxDb,
        { clientId: "c1", origin: NAMED, userId: "u1", scopes: RW },
        "owner",
        NOW,
      );
      await addToken(db);
      const res = await call("/api/prefs", { headers: named() });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(NAMED);
      expect(await verifyBoxIdentity(SECRET, seen?.headers.get(BOX_IDENTITY_HEADER), NOW)).toEqual({
        userId: "u1",
        clientId: "c1",
      });
      seen = null;
      for (const origin of [
        ORIGIN,
        "https://my-other-name.lianki.com",
        "https://my-example.lianki.com.evil.com",
      ])
        expect((await call("/api/prefs", { headers: named({ origin }) })).status).toBe(403);
      expect(seen).toBeNull();
    });

    test("a reserved name is not a box, even with a token", async () => {
      const res = await call("/api/prefs", {
        headers: named({ origin: "https://my-admin.lianki.com" }),
      });
      expect(res.status).toBe(403);
      expect(seen).toBeNull();
    });
  });

  test("the code exchange: a registered box only, no cookie reaches the app", async () => {
    const init = { method: "POST", headers: { origin: ORIGIN }, body: "grant_type=x" };
    const res = await call("/api/auth/oauth2/token", init);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(
      (await call("/api/auth/oauth2/token", { ...init, headers: { origin: OTHER } })).status,
    ).toBe(403);
  });
});
