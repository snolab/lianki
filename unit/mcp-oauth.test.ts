/**
 * OAuth sign-in for the remote MCP server (docs/mcp-oauth.md): metadata,
 * registration, consent, PKCE, refresh, revocation, the flag, and that an
 * OAuth access token is checked exactly as an lk_ token (lib/api-tokens.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import type { D1Like } from "../lib/d1/types";
import {
  checkToken,
  createToken,
  describeToken,
  listTokens,
  revokeAllTokens,
} from "../lib/api-tokens";
import { FLAGS } from "../lib/flags";
import {
  authorizeView,
  consent,
  metadata,
  myApps,
  register,
  revoke,
  token,
  type OAuthDeps,
} from "../lib/mcp-oauth/handlers";
import { AUTHORIZE_PATH, MCP_OAUTH_SCOPES, s256 } from "../lib/mcp-oauth/rules";
import { signInReturnPath } from "../lib/dev-server-switch";
import { oauthMetadataKind } from "../middleware";
import { handle, resetOauthProbe, type Env } from "../workers/mcp/src/mcp";

const ORIGIN = "https://lianki.com";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(12);
let db: TestD1Database;
let deps: OAuthDeps;
let signedIn: { id: string; email: string } | null;
let now: number;
let revokedIds: string[];
let hits: Map<string, number>;
let registerMax: number;

const D = () => db as unknown as D1Like;
const setFlag = (on: boolean) =>
  db
    .raw()
    .exec(
      `INSERT OR REPLACE INTO feature_flags(key,enabled,updated_at,updated_by) VALUES('mcp.oauth',${on ? 1 : 0},'2026-11-25','test')`,
    );

beforeEach(() => {
  db = createTestD1(testSchema());
  db.raw().exec(
    "INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES('u1','u1@example.com',1,'2026-11-01','2026-11-01'),('u2','u2@example.com',1,'2026-11-01','2026-11-01')",
  );
  setFlag(true);
  signedIn = { id: "u1", email: "u1@example.com" };
  now = Date.parse("2026-11-25T00:00:00Z");
  revokedIds = [];
  hits = new Map();
  registerMax = 50;
  deps = {
    db: () => D(),
    flagOn: async () =>
      (
        await D()
          .prepare("SELECT enabled FROM feature_flags WHERE key='mcp.oauth'")
          .first<{ enabled: number }>()
      )?.enabled === 1,
    limits: async () => ({
      accessMin: 60,
      refreshDays: 30,
      codeSeconds: 60,
      registerPerHour: registerMax,
      tokenPerMin: 100,
    }),
    allow: async (key, max) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return n <= max;
    },
    user: async () => signedIn,
    revoked: async (ids) => {
      revokedIds.push(...ids);
    },
    ip: () => "203.0.113.9",
    now: () => now,
  };
});

async function registerApp(body: Record<string, unknown> = {}) {
  const res = await register(
    new Request(`${ORIGIN}/api/mcp-oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...body,
      }),
    }),
    deps,
  );
  const text = await res.text();
  return { res, body: (text ? JSON.parse(text) : {}) as Record<string, string> };
}

async function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await s256(VERIFIER),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "study chat:read",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  });
}

const navigation = {
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-user": "?1",
  "content-type": "application/x-www-form-urlencoded",
};

async function approve(
  q: URLSearchParams,
  opts: { decision?: string; grant?: string[]; headers?: Record<string, string> } = {},
) {
  const form = new URLSearchParams(q);
  form.set("decision", opts.decision ?? "allow");
  for (const g of opts.grant ?? ["study", "chat:read"]) form.append("grant", g);
  return consent(
    new Request(`${ORIGIN}/api/mcp-oauth/consent`, {
      method: "POST",
      headers: opts.headers ?? navigation,
      body: form.toString(),
    }),
    deps,
  );
}

function codeOf(res: Response): string {
  expect(res.status).toBe(303);
  const u = new URL(res.headers.get("location")!);
  expect(u.origin + u.pathname).toBe(REDIRECT);
  expect(u.searchParams.get("iss")).toBe(ORIGIN);
  expect(u.searchParams.get("state")).toBe("st-1");
  return u.searchParams.get("code")!;
}

function tokenReq(form: Record<string, string>, headers: Record<string, string> = {}) {
  return token(
    new Request(`${ORIGIN}/api/mcp-oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
    }),
    deps,
  );
}

async function connect(clientId: string) {
  const q = await authorizeQuery(clientId);
  const code = codeOf(await approve(q));
  const res = await tokenReq({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: `${ORIGIN}/mcp`,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
}

describe("metadata", () => {
  test("protected resource and authorization server documents", async () => {
    const pr = await metadata(
      new Request(`${ORIGIN}/api/mcp-oauth/metadata/protected-resource`),
      "protected-resource",
      deps,
    );
    expect(pr.status).toBe(200);
    const p = await pr.json();
    expect(p.resource).toBe(`${ORIGIN}/mcp`);
    expect(p.authorization_servers).toEqual([ORIGIN]);
    expect(p.scopes_supported).toEqual([...MCP_OAUTH_SCOPES]);

    const as = await (
      await metadata(new Request(`${ORIGIN}/x`), "authorization-server", deps)
    ).json();
    expect(as.issuer).toBe(ORIGIN);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}${AUTHORIZE_PATH}`);
    expect(as.token_endpoint).toBe(`${ORIGIN}/api/mcp-oauth/token`);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/api/mcp-oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
  });

  test("the middleware sends both well-known paths (and the /mcp suffixed one) there", () => {
    expect(oauthMetadataKind("/.well-known/oauth-protected-resource")).toBe("protected-resource");
    expect(oauthMetadataKind("/.well-known/oauth-protected-resource/mcp")).toBe(
      "protected-resource",
    );
    expect(oauthMetadataKind("/.well-known/oauth-authorization-server")).toBe(
      "authorization-server",
    );
    expect(oauthMetadataKind("/.well-known/oauth-protected-resource/other")).toBeNull();
    expect(oauthMetadataKind("/.well-known/openid-configuration")).toBeNull();
  });
});

describe("registration", () => {
  test("a public client gets an id and no secret", async () => {
    const { res, body } = await registerApp();
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^lkc_[0-9a-f]{32}$/);
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  test("a confidential client gets a secret, stored only hashed", async () => {
    const { body } = await registerApp({ token_endpoint_auth_method: "client_secret_post" });
    expect(body.client_secret).toMatch(/^lkcs_/);
    const row = await D()
      .prepare("SELECT secret_hash FROM mcp_oauth_client WHERE client_id = ?")
      .bind(body.client_id)
      .first<{ secret_hash: string }>();
    expect(row!.secret_hash).not.toContain(body.client_secret);
    expect(row!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("bad redirect URIs and unknown methods are refused", async () => {
    for (const uris of [
      [],
      ["http://evil.example/cb"],
      ["javascript:alert(1)"],
      ["https://a.b/#x"],
    ])
      expect((await registerApp({ redirect_uris: uris })).res.status).toBe(400);
    expect((await registerApp({ token_endpoint_auth_method: "private_key_jwt" })).res.status).toBe(
      400,
    );
    expect((await registerApp({ grant_types: ["client_credentials"] })).res.status).toBe(400);
  });

  test("loopback http is allowed for desktop apps", async () => {
    expect(
      (await registerApp({ redirect_uris: ["http://127.0.0.1:33418/callback"] })).res.status,
    ).toBe(201);
  });

  test("rate-limited per IP", async () => {
    registerMax = 3;
    for (let i = 0; i < 3; i++) await registerApp();
    expect((await registerApp()).res.status).toBe(429);
  });
});

describe("authorize and consent", () => {
  test("signed out: sent to sign in, and the sign-in page returns to the consent page", async () => {
    const { body } = await registerApp();
    signedIn = null;
    const v = await authorizeView(
      await authorizeQuery(body.client_id),
      ORIGIN,
      AUTHORIZE_PATH,
      deps,
    );
    expect(v.kind).toBe("sign-in");
    const back = (v as { back: string }).back;
    expect(back.startsWith(`${AUTHORIZE_PATH}?`)).toBe(true);
    expect(signInReturnPath(back)).toBe(back);
  });

  test("opening the consent page names the app and its host and mints nothing", async () => {
    const { body } = await registerApp();
    const v = await authorizeView(
      await authorizeQuery(body.client_id),
      ORIGIN,
      AUTHORIZE_PATH,
      deps,
    );
    expect(v.kind).toBe("consent");
    const c = v as Extract<typeof v, { kind: "consent" }>;
    expect(c.client.name).toBe("ChatGPT");
    expect(c.host).toBe("chatgpt.com");
    expect(c.request.scopes).toEqual(["study", "chat:read"]);
    const n = await D().prepare("SELECT COUNT(*) AS n FROM mcp_oauth_code").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  test("unknown client or unregistered redirect is never redirected", async () => {
    const { body } = await registerApp();
    const q = await authorizeQuery(body.client_id, { redirect_uri: "https://evil.example/cb" });
    expect((await authorizeView(q, ORIGIN, AUTHORIZE_PATH, deps)).kind).toBe("invalid");
    const q2 = await authorizeQuery(`lkc_${"0".repeat(32)}`);
    expect((await authorizeView(q2, ORIGIN, AUTHORIZE_PATH, deps)).kind).toBe("invalid");
  });

  test("no PKCE or plain PKCE goes back to the app as an error, with iss", async () => {
    const { body } = await registerApp();
    const q = await authorizeQuery(body.client_id, { code_challenge_method: "plain" });
    const v = await authorizeView(q, ORIGIN, AUTHORIZE_PATH, deps);
    expect(v.kind).toBe("redirect");
    const u = new URL((v as { to: string }).to);
    expect(u.searchParams.get("error")).toBe("invalid_request");
    expect(u.searchParams.get("iss")).toBe(ORIGIN);
  });

  test("owner-only scopes are never offered", async () => {
    const { body } = await registerApp();
    const q = await authorizeQuery(body.client_id, { scope: "eval progress study" });
    const v = await authorizeView(q, ORIGIN, AUTHORIZE_PATH, deps);
    expect((v as { request: { scopes: string[] } }).request.scopes).toEqual(["study"]);
    // Even a tampered form that ticks one gets only what was offered.
    const code = codeOf(await approve(q, { grant: ["study", "eval"] }));
    const res = await tokenReq({
      grant_type: "authorization_code",
      code,
      client_id: body.client_id,
      code_verifier: VERIFIER,
    });
    expect((await res.json()).scope).toBe("study");
  });

  test("consent counts only as the user's own click on lianki.com", async () => {
    const { body } = await registerApp();
    const q = await authorizeQuery(body.client_id);
    for (const drop of ["sec-fetch-user", "sec-fetch-mode", "origin"]) {
      const h: Record<string, string> = { ...navigation };
      delete h[drop];
      expect((await approve(q, { headers: h })).status).toBe(403);
    }
    expect(
      (await approve(q, { headers: { ...navigation, origin: "https://evil.example" } })).status,
    ).toBe(403);
    signedIn = null;
    expect((await approve(q)).status).toBe(401);
  });

  test("Deny sends access_denied back, and no code exists", async () => {
    const { body } = await registerApp();
    const res = await approve(await authorizeQuery(body.client_id), { decision: "deny" });
    const u = new URL(res.headers.get("location")!);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("code")).toBeNull();
    expect(u.searchParams.get("iss")).toBe(ORIGIN);
  });
});

describe("token endpoint", () => {
  test("a wrong PKCE verifier is refused, and the code is spent", async () => {
    const { body } = await registerApp();
    const code = codeOf(await approve(await authorizeQuery(body.client_id)));
    const bad = await tokenReq({
      grant_type: "authorization_code",
      code,
      client_id: body.client_id,
      code_verifier: "w".repeat(43),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");
    const again = await tokenReq({
      grant_type: "authorization_code",
      code,
      client_id: body.client_id,
      code_verifier: VERIFIER,
    });
    expect((await again.json()).error).toBe("invalid_grant");
  });

  test("a code expires", async () => {
    const { body } = await registerApp();
    const code = codeOf(await approve(await authorizeQuery(body.client_id)));
    now += 61_000;
    const res = await tokenReq({
      grant_type: "authorization_code",
      code,
      client_id: body.client_id,
      code_verifier: VERIFIER,
    });
    expect((await res.json()).error).toBe("invalid_grant");
  });

  test("another client cannot use this client's code or refresh token", async () => {
    const a = (await registerApp()).body;
    const b = (await registerApp({ client_name: "Other" })).body;
    const code = codeOf(await approve(await authorizeQuery(a.client_id)));
    const res = await tokenReq({
      grant_type: "authorization_code",
      code,
      client_id: b.client_id,
      code_verifier: VERIFIER,
    });
    expect((await res.json()).error).toBe("invalid_grant");

    const t = await connect(a.client_id);
    const r = await tokenReq({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: b.client_id,
    });
    expect((await r.json()).error).toBe("invalid_grant");
  });

  test("a confidential client must authenticate", async () => {
    const c = (await registerApp({ token_endpoint_auth_method: "client_secret_basic" })).body;
    const code = codeOf(await approve(await authorizeQuery(c.client_id)));
    const noSecret = await tokenReq({
      grant_type: "authorization_code",
      code,
      client_id: c.client_id,
      code_verifier: VERIFIER,
    });
    expect(noSecret.status).toBe(401);
    const code2 = codeOf(await approve(await authorizeQuery(c.client_id)));
    const basic = btoa(`${c.client_id}:${c.client_secret}`);
    const ok = await tokenReq(
      { grant_type: "authorization_code", code: code2, code_verifier: VERIFIER },
      { authorization: `Basic ${basic}` },
    );
    expect(ok.status).toBe(200);
  });

  test("an access token, then refresh rotation: the old refresh and access tokens stop", async () => {
    const { body } = await registerApp();
    const t = await connect(body.client_id);
    expect(t.token_type).toBe("Bearer");
    expect(t.access_token).toMatch(/^lk_[0-9a-f]{64}$/);
    expect(t.expires_in).toBe(3600);
    expect(t.scope).toBe("study chat:read");

    const r = await tokenReq({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: body.client_id,
    });
    const t2 = await r.json();
    expect(r.status).toBe(200);
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect((await checkToken(D(), t.access_token, "study", now)).ok).toBe(false);
    expect((await checkToken(D(), t2.access_token, "study", now)).ok).toBe(true);
    const reuse = await tokenReq({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: body.client_id,
    });
    expect((await reuse.json()).error).toBe("invalid_grant");
  });

  test("access tokens expire", async () => {
    const { body } = await registerApp();
    const t = await connect(body.client_id);
    expect((await checkToken(D(), t.access_token, "study", now + 3_599_000)).ok).toBe(true);
    expect((await checkToken(D(), t.access_token, "study", now + 3_601_000)).ok).toBe(false);
  });
});

describe("one check for OAuth and lk_ tokens", () => {
  test("an OAuth token and an lk_ token with the same scopes give the same access", async () => {
    const { body } = await registerApp();
    const oauth = (await connect(body.client_id)).access_token;
    const manual = (
      await createToken(
        D(),
        { userId: "u1", email: "u1@example.com" },
        { name: "manual", scopes: ["study", "chat:read"], expiresAt: new Date(now + 86_400_000) },
        now,
      )
    ).token;
    for (const scope of ["study", "chat:read", "chat:write", "eval"] as const) {
      const a = await checkToken(D(), oauth, scope, now);
      const b = await checkToken(D(), manual, scope, now);
      expect(a.ok).toBe(b.ok);
      if (a.ok && b.ok) {
        expect(a.user).toEqual(b.user);
        expect(a.scopes).toEqual(b.scopes);
      } else expect((a as { reason: string }).reason).toBe((b as { reason: string }).reason);
    }
    expect((await describeToken(D(), oauth, now))!.scopes).toEqual(
      (await describeToken(D(), manual, now))!.scopes,
    );
  });

  test("OAuth tokens are not in the account's token list", async () => {
    const { body } = await registerApp();
    await connect(body.client_id);
    expect(await listTokens(D(), { userId: "u1", email: "u1@example.com" }, now)).toEqual([]);
  });
});

describe("revocation", () => {
  test("disconnecting the app ends its tokens, and the hub is told", async () => {
    const { body } = await registerApp();
    const t = await connect(body.client_id);
    const list = await (await myApps(new Request(`${ORIGIN}/api/my/connected-apps`), deps)).json();
    expect(list.apps).toHaveLength(1);
    expect(list.apps[0]).toMatchObject({ name: "ChatGPT", host: "chatgpt.com" });
    const del = (id: string, extra: Record<string, string> = {}) =>
      myApps(
        new Request(`${ORIGIN}/api/my/connected-apps`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
            ...extra,
          },
          body: JSON.stringify({ id }),
        }),
        deps,
      );
    expect((await del(list.apps[0].id, { origin: "https://evil.example" })).status).toBe(403);
    signedIn = { id: "u2", email: "u2@example.com" };
    expect((await del(list.apps[0].id)).status).toBe(404);
    signedIn = { id: "u1", email: "u1@example.com" };
    expect((await del(list.apps[0].id)).status).toBe(200);
    expect(revokedIds).toHaveLength(1);
    expect((await checkToken(D(), t.access_token, "study", now)).ok).toBe(false);
    const r = await tokenReq({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: body.client_id,
    });
    expect((await r.json()).error).toBe("invalid_grant");
  });

  test("RFC 7009 revoke by the app, and sign-out everywhere", async () => {
    const { body } = await registerApp();
    const t = await connect(body.client_id);
    const res = await revoke(
      new Request(`${ORIGIN}/api/mcp-oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refresh_token, client_id: body.client_id }).toString(),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect((await checkToken(D(), t.access_token, "study", now)).ok).toBe(false);

    const t2 = await connect(body.client_id);
    await revokeAllTokens(D(), { userId: "u1", email: "u1@example.com" });
    expect((await checkToken(D(), t2.access_token, "study", now)).ok).toBe(false);
    const n = await D().prepare("SELECT COUNT(*) AS n FROM mcp_oauth_grant").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("the flag", () => {
  test("mcp.oauth is off by default (an auth change)", () => {
    expect(FLAGS["mcp.oauth"].default).toBe(false);
  });

  test("off: every endpoint is 404 and issued tokens stop; on again: they work", async () => {
    const { body } = await registerApp();
    const t = await connect(body.client_id);
    setFlag(false);
    expect((await metadata(new Request(`${ORIGIN}/x`), "protected-resource", deps)).status).toBe(
      404,
    );
    expect((await metadata(new Request(`${ORIGIN}/x`), "authorization-server", deps)).status).toBe(
      404,
    );
    expect((await registerApp()).res.status).toBe(404);
    expect(
      (await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status,
    ).toBe(404);
    expect((await approve(await authorizeQuery(body.client_id))).status).toBe(404);
    expect(
      (await authorizeView(await authorizeQuery(body.client_id), ORIGIN, AUTHORIZE_PATH, deps))
        .kind,
    ).toBe("not-found");
    expect((await checkToken(D(), t.access_token, "study", now)).ok).toBe(false);
    expect(await describeToken(D(), t.access_token, now)).toBeNull();
    // No row at all reads as the default, off.
    db.raw().exec("DELETE FROM feature_flags WHERE key='mcp.oauth'");
    expect((await checkToken(D(), t.access_token, "study", now)).ok).toBe(false);
    setFlag(true);
    expect((await checkToken(D(), t.access_token, "study", now)).ok).toBe(true);
  });
});

describe("the MCP Worker's challenge", () => {
  function env(prm: number): Env {
    const f = {
      fetch: async (req: Request) => {
        if (new URL(req.url).pathname.startsWith("/.well-known/oauth-protected-resource"))
          return new Response("{}", { status: prm });
        return new Response(null, { status: 401 });
      },
    };
    return { MAIN: f, PUSH: f };
  }
  const post = () =>
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

  test("with OAuth on, the 401 names the resource metadata", async () => {
    resetOauthProbe();
    const res = await handle(post(), env(200));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="lianki", resource_metadata="https://lianki.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("a /mcp/<token> address never offers sign-in", async () => {
    resetOauthProbe();
    const req = new Request(`${ORIGIN}/mcp/lk_${"a".repeat(64)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const res = await handle(req, env(200));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="lianki"');
  });

  test("with OAuth off, the 401 is the plain one, as before", async () => {
    resetOauthProbe();
    const res = await handle(post(), env(404));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="lianki"');
  });
});
