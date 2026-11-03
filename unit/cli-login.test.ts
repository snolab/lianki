import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { useBackend, useD1 } from "./support/testMocks";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  CODE_TTL_MS,
  EXCHANGES_PER_IP,
  PENDING_TTL_MS,
  approveRequest,
  base64url,
  cleanHost,
  exchangeCode,
  loopbackRedirect,
  parseLoginParams,
  randomId,
  revokeSelf,
  s256,
  sameOriginPost,
  sameString,
  startRequest,
  tokenName,
  validChallenge,
  validState,
  validVerifier,
} from "@/lib/cli-login";
import { apiTokenUser } from "@/lib/api-token-user";
import { sha256Hex } from "@/lib/security/throttle";

const SCHEMA = testSchema();
const T0 = Date.parse("2026-11-02T00:00:00Z");
let d1: TestD1Database;
const db = () => d1 as unknown as D1Like;

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  useD1(d1);
  useBackend("d1");
  for (const id of ["u1", "u2"])
    d1.raw()
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
      )
      .run(id, `${id}@example.com`);
});

describe("the loopback redirect allow-list", () => {
  test("accepts only http://127.0.0.1:<port>/cb and http://[::1]:<port>/cb", () => {
    expect(loopbackRedirect("http://127.0.0.1:52123/cb")).toBe("http://127.0.0.1:52123/cb");
    expect(loopbackRedirect("http://[::1]:8080/cb")).toBe("http://[::1]:8080/cb");
    expect(loopbackRedirect("http://127.0.0.1:1/cb")).toBe("http://127.0.0.1:1/cb");
    expect(loopbackRedirect("http://127.0.0.1:65535/cb")).toBe("http://127.0.0.1:65535/cb");
  });

  test.each([
    // other hosts
    "http://localhost:5000/cb",
    "http://evil.com:5000/cb",
    "http://127.0.0.1.evil.com:5000/cb",
    "http://127.0.0.2:5000/cb",
    "http://127.1:5000/cb",
    "http://2130706433:5000/cb",
    "http://0x7f000001:5000/cb",
    "http://0.0.0.0:5000/cb",
    "http://[::]:5000/cb",
    // userinfo tricks
    "http://127.0.0.1:5000@evil.com/cb",
    "http://evil.com@127.0.0.1:5000/cb",
    // user:password userinfo, joined so the secret scanner does not read it as one
    ["http://user", "x@127.0.0.1:5000/cb"].join(":"),
    "http://127.0.0.1@evil.com:5000/cb",
    "http://127.0.0.1:5000\\@evil.com/cb",
    // IPv6 variants
    "http://[::ffff:127.0.0.1]:5000/cb",
    "http://[0:0:0:0:0:0:0:1]:5000/cb",
    "http://[::1%25en0]:5000/cb",
    "http://[::0001]:5000/cb",
    "http://::1:5000/cb",
    "http://[::1]/cb",
    // ports: missing, non-numeric, out of range, padded
    "http://127.0.0.1/cb",
    "http://127.0.0.1:/cb",
    "http://127.0.0.1:abc/cb",
    "http://127.0.0.1:80a/cb",
    "http://127.0.0.1:0/cb",
    "http://127.0.0.1:065535/cb",
    "http://127.0.0.1:65536/cb",
    "http://127.0.0.1:99999/cb",
    "http://127.0.0.1:+80/cb",
    "http://127.0.0.1: 80/cb",
    // scheme, path, query, fragment, case, whitespace
    "https://127.0.0.1:5000/cb",
    "javascript://127.0.0.1:5000/cb",
    "//127.0.0.1:5000/cb",
    "http://127.0.0.1:5000/",
    "http://127.0.0.1:5000/cb/",
    "http://127.0.0.1:5000/cb/../x",
    "http://127.0.0.1:5000/cb?next=https://evil.com",
    "http://127.0.0.1:5000/cb#x",
    "HTTP://127.0.0.1:5000/cb",
    " http://127.0.0.1:5000/cb",
    "http://127.0.0.1:5000/cb\n",
    "",
  ])("refuses %p", (raw) => {
    expect(loopbackRedirect(raw)).toBeNull();
  });

  test("refuses non-strings and overlong input", () => {
    expect(loopbackRedirect(undefined)).toBeNull();
    expect(loopbackRedirect(["http://127.0.0.1:5000/cb"])).toBeNull();
    expect(loopbackRedirect(`http://127.0.0.1:5000/cb${"x".repeat(40)}`)).toBeNull();
  });
});

describe("the page's parameters", () => {
  const challenge = "a".repeat(43);
  const good = {
    redirect_uri: "http://127.0.0.1:5000/cb",
    state: "s".repeat(22),
    code_challenge: challenge,
    host: "my-mac",
  };

  test("a good query parses, host cleaned into the token name", () => {
    const p = parseLoginParams({ ...good, host: "my mac<script>" });
    expect(p).toEqual({
      ok: true,
      params: {
        redirectUri: good.redirect_uri,
        state: good.state,
        challenge,
        host: "mymacscript",
      },
    });
    expect(tokenName("my-mac")).toBe("lianki CLI my-mac");
    expect(cleanHost(undefined)).toBe("unknown");
    expect(cleanHost("!!!")).toBe("unknown");
  });

  test("each bad parameter is named, and nothing redirects", () => {
    expect(parseLoginParams({ ...good, redirect_uri: "https://evil.com/cb" })).toEqual({
      ok: false,
      error: "redirect_uri",
    });
    expect(parseLoginParams({ ...good, redirect_uri: [good.redirect_uri, "x"] })).toEqual({
      ok: false,
      error: "redirect_uri",
    });
    expect(parseLoginParams({ ...good, state: "short" })).toEqual({ ok: false, error: "state" });
    expect(parseLoginParams({ ...good, code_challenge: "x" })).toEqual({
      ok: false,
      error: "code_challenge",
    });
    expect(parseLoginParams({ ...good, code_challenge_method: "plain" })).toEqual({
      ok: false,
      error: "code_challenge_method",
    });
  });

  test("validators", () => {
    expect(validState("a".repeat(15))).toBe(false);
    expect(validState("a".repeat(129))).toBe(false);
    expect(validState("a/b".repeat(8))).toBe(false);
    expect(validChallenge("a".repeat(44))).toBe(false);
    expect(validVerifier("a".repeat(42))).toBe(false);
    expect(validVerifier("a~._-".repeat(10))).toBe(true);
    expect(sameString("abc", "abd")).toBe(false);
    expect(sameString("abc", "ab")).toBe(false);
    expect(sameString("abc", "abc")).toBe(true);
  });

  test("S256 matches RFC 7636's example", async () => {
    // RFC 7636, Appendix B.
    expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(base64url(new Uint8Array([251, 255]))).toBe("-_8");
    expect(randomId(32)).toHaveLength(43);
  });
});

describe("the code exchange", () => {
  async function flow(now = T0) {
    const verifier = randomId(48);
    const params = {
      redirectUri: "http://127.0.0.1:5000/cb",
      state: randomId(24),
      challenge: await s256(verifier),
      host: "my-mac",
    };
    const requestId = await startRequest(
      db(),
      { userId: "u1", email: "u1@example.com" },
      params,
      now,
    );
    return { verifier, params, requestId };
  }
  const codeOf = (redirect: string) => new URL(redirect).searchParams.get("code")!;

  test("approve → code on the loopback URL → token in the body, once", async () => {
    const { verifier, params, requestId } = await flow();
    const a = await approveRequest(
      db(),
      { requestId, userId: "u1", state: params.state },
      T0 + 1000,
    );
    if (!a.ok) throw new Error("approve failed");
    const u = new URL(a.redirect);
    expect(`${u.origin}${u.pathname}`).toBe(params.redirectUri);
    expect(u.searchParams.get("state")).toBe(params.state);
    expect(u.searchParams.has("token")).toBe(false);
    expect(a.redirect).not.toContain("lk_");

    const x = await exchangeCode(
      db(),
      { code: codeOf(a.redirect), verifier, redirectUri: params.redirectUri },
      T0 + 2000,
    );
    if (!x.ok) throw new Error(`exchange failed: ${x.error}`);
    expect(x.token).toMatch(/^lk_[0-9a-f]{64}$/);
    expect(x.name).toBe("lianki CLI my-mac");
    expect(x.email).toBe("u1@example.com");
    expect(x.tokenHash).toBe(await sha256Hex(x.token));

    // Nothing raw is stored: no code, no token, no request id.
    const dump = JSON.stringify(d1.raw().prepare("SELECT * FROM cli_login").all());
    expect(dump).not.toContain(codeOf(a.redirect));
    expect(dump).not.toContain(requestId);
    const tokens = JSON.stringify(d1.raw().prepare("SELECT * FROM api_tokens").all());
    expect(tokens).not.toContain(x.token);

    // Reuse: the code is gone.
    expect(
      await exchangeCode(
        db(),
        { code: codeOf(a.redirect), verifier, redirectUri: params.redirectUri },
        T0 + 3000,
      ),
    ).toEqual({ ok: false, status: 400, error: "invalid_grant" });
  });

  test("a state mismatch, another user, or a second click gets no code", async () => {
    const { params, requestId } = await flow();
    expect(
      await approveRequest(db(), { requestId, userId: "u1", state: randomId(24) }, T0 + 1),
    ).toEqual({ ok: false, status: 404 });
    expect(
      await approveRequest(db(), { requestId, userId: "u2", state: params.state }, T0 + 1),
    ).toEqual({ ok: false, status: 404 });
    expect(
      await approveRequest(db(), { requestId: "x/y", userId: "u1", state: params.state }, T0 + 1),
    ).toEqual({ ok: false, status: 400 });
    expect(await approveRequest(db(), { requestId, userId: "u1", state: 5 }, T0 + 1)).toEqual({
      ok: false,
      status: 400,
    });
    expect(
      (await approveRequest(db(), { requestId, userId: "u1", state: params.state }, T0 + 1)).ok,
    ).toBe(true);
    expect(
      await approveRequest(db(), { requestId, userId: "u1", state: params.state }, T0 + 2),
    ).toEqual({ ok: false, status: 404 });
  });

  test("the Approve button expires after ten minutes", async () => {
    const { params, requestId } = await flow();
    expect(
      await approveRequest(
        db(),
        { requestId, userId: "u1", state: params.state },
        T0 + PENDING_TTL_MS,
      ),
    ).toEqual({ ok: false, status: 404 });
  });

  test("the code expires after 60 s, and an expired code is burnt", async () => {
    const { verifier, params, requestId } = await flow();
    const a = await approveRequest(db(), { requestId, userId: "u1", state: params.state }, T0);
    if (!a.ok) throw new Error("approve failed");
    const x = { code: codeOf(a.redirect), verifier, redirectUri: params.redirectUri };
    expect(await exchangeCode(db(), x, T0 + CODE_TTL_MS)).toEqual({
      ok: false,
      status: 400,
      error: "expired",
    });
    expect((await exchangeCode(db(), x, T0 + 1)).ok).toBe(false);
  });

  test("a wrong verifier mints nothing and burns the code", async () => {
    const { verifier, params, requestId } = await flow();
    const a = await approveRequest(db(), { requestId, userId: "u1", state: params.state }, T0);
    if (!a.ok) throw new Error("approve failed");
    const code = codeOf(a.redirect);
    expect(
      await exchangeCode(
        db(),
        { code, verifier: randomId(48), redirectUri: params.redirectUri },
        T0 + 1,
      ),
    ).toEqual({ ok: false, status: 400, error: "code_verifier" });
    expect(
      (await exchangeCode(db(), { code, verifier, redirectUri: params.redirectUri }, T0 + 2)).ok,
    ).toBe(false);
    expect(d1.raw().prepare("SELECT COUNT(*) AS n FROM api_tokens").get()).toEqual({ n: 0 });
  });

  test("the redirect it was sent to must match; malformed input is refused up front", async () => {
    const { verifier, params, requestId } = await flow();
    const a = await approveRequest(db(), { requestId, userId: "u1", state: params.state }, T0);
    if (!a.ok) throw new Error("approve failed");
    expect(
      await exchangeCode(
        db(),
        { code: codeOf(a.redirect), verifier, redirectUri: "http://127.0.0.1:5001/cb" },
        T0 + 1,
      ),
    ).toEqual({ ok: false, status: 400, error: "redirect_uri" });
    expect(await exchangeCode(db(), { code: 1, verifier, redirectUri: "" }, T0)).toEqual({
      ok: false,
      status: 400,
      error: "code",
    });
    expect(
      await exchangeCode(db(), { code: "abc", verifier: "short", redirectUri: "" }, T0),
    ).toEqual({
      ok: false,
      status: 400,
      error: "code_verifier",
    });
  });

  test("starting a request clears expired rows", async () => {
    await flow(T0);
    await flow(T0 + PENDING_TTL_MS + 1);
    expect(d1.raw().prepare("SELECT COUNT(*) AS n FROM cli_login").get()).toEqual({ n: 1 });
  });

  test("a token revokes itself and nothing else", async () => {
    const insert = async (t: string, email: string) =>
      d1
        .raw()
        .prepare(
          "INSERT INTO api_tokens (token_hash, email, name, created_at) VALUES (?, ?, 'x', '')",
        )
        .run(await sha256Hex(t), email);
    const mine = `lk_${"1".repeat(64)}`;
    const theirs = `lk_${"2".repeat(64)}`;
    await insert(mine, "u1@example.com");
    await insert(theirs, "u2@example.com");
    expect(await revokeSelf(db(), "nope")).toBe(false);
    expect(await revokeSelf(db(), mine)).toBe(true);
    expect(await revokeSelf(db(), mine)).toBe(false);
    expect(d1.raw().prepare("SELECT email FROM api_tokens").all()).toEqual([
      { email: "u2@example.com" },
    ]);
  });
});

describe("CSRF on Approve", () => {
  const req = (h: Record<string, string>, method = "POST") =>
    new Request("https://lianki.com/api/cli-login/approve", { method, headers: h });
  const json = { "content-type": "application/json" };

  test("same-origin JSON only", () => {
    expect(sameOriginPost(req({ ...json, origin: "https://lianki.com" }))).toBe(true);
    expect(
      sameOriginPost(
        req({ ...json, origin: "https://lianki.com", "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
    expect(sameOriginPost(req({ ...json, origin: "https://evil.com" }))).toBe(false);
    expect(sameOriginPost(req({ ...json }))).toBe(false);
    expect(
      sameOriginPost(
        req({ ...json, origin: "https://lianki.com", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    expect(
      sameOriginPost(
        req({ "content-type": "application/x-www-form-urlencoded", origin: "https://lianki.com" }),
      ),
    ).toBe(false);
    expect(sameOriginPost(req({ ...json, origin: "https://lianki.com" }, "GET"))).toBe(false);
  });
});

// ── The Bearer path: /api/prefs, and nothing else ──────────────────────────

const TOKEN = `lk_${"a".repeat(64)}`;
async function seedToken() {
  d1.raw()
    .prepare(
      "INSERT INTO api_tokens (token_hash, email, name, created_at) VALUES (?, ?, 'cli', '')",
    )
    .run(await sha256Hex(TOKEN), "u1@example.com");
}

describe("apiTokenUser", () => {
  const req = (auth?: string) =>
    new Request("https://lianki.com/api/prefs", {
      headers: auth === undefined ? {} : { Authorization: auth },
    });

  test("no header: undefined (the session decides)", async () => {
    expect(await apiTokenUser(req())).toBeUndefined();
  });

  test("a known lk_ token: its user", async () => {
    await seedToken();
    expect(await apiTokenUser(req(`Bearer ${TOKEN}`))).toMatchObject({
      id: "u1",
      email: "u1@example.com",
    });
  });

  test("anything else: null, never the cookie", async () => {
    await seedToken();
    for (const h of [
      "",
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer lk_${"b".repeat(64)}`,
      `Bearer ${TOKEN.toUpperCase()}`,
    ])
      expect(await apiTokenUser(req(h))).toBeNull();
    useBackend("mongodb");
    expect(await apiTokenUser(req(`Bearer ${TOKEN}`))).toBeNull();
  });
});

describe("/api/prefs with a Bearer token", async () => {
  const { GET, PATCH } = await import("@/app/api/prefs/route");
  const { NextRequest } = await import("next/server");
  const at = (init: { method?: string; auth?: string; body?: string; query?: string } = {}) =>
    new NextRequest(`https://lianki.com/api/prefs${init.query ?? ""}`, {
      method: init.method ?? "GET",
      headers: init.auth ? { Authorization: init.auth } : {},
      body: init.body,
    });
  const hlc = { timestamp: T0, counter: 0, deviceId: "cli0000001" };

  test("reads and writes the token's own settings", async () => {
    await seedToken();
    const w = await PATCH(
      at({
        method: "PATCH",
        auth: `Bearer ${TOKEN}`,
        body: JSON.stringify({ ops: [{ key: "words.readAloud", value: true, hlc }] }),
      }),
    );
    expect(w.status).toBe(200);
    expect((await w.json()).rejected).toEqual([]);
    const r = await GET(at({ auth: `Bearer ${TOKEN}`, query: "?since=0" }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.user).toBe("u1");
    expect(j.prefs["words.readAloud"].value).toBe(true);
  });

  test("an unknown token is 401, not a fall back to the session", async () => {
    const bad = `Bearer lk_${"c".repeat(64)}`;
    expect((await GET(at({ auth: bad }))).status).toBe(401);
    expect((await PATCH(at({ method: "PATCH", auth: bad, body: "{}" }))).status).toBe(401);
  });

  test("the usual checks still apply", async () => {
    await seedToken();
    const auth = `Bearer ${TOKEN}`;
    expect((await PATCH(at({ method: "PATCH", auth, body: "x".repeat(17 * 1024) }))).status).toBe(
      413,
    );
    expect((await PATCH(at({ method: "PATCH", auth, body: "{" }))).status).toBe(400);
    expect((await PATCH(at({ method: "PATCH", auth, body: '{"ops":1}' }))).status).toBe(400);
  });

  test("the frozen Mongo copy refuses every token", async () => {
    await seedToken();
    useBackend("mongodb");
    expect((await GET(at({ auth: `Bearer ${TOKEN}` }))).status).toBe(401);
  });
});

describe("/api/cli-login/token", async () => {
  const { POST, DELETE } = await import("@/app/api/cli-login/token/route");
  const post = (body: unknown, ip = "203.0.113.5") =>
    POST(
      new Request("https://lianki.com/api/cli-login/token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body),
      }),
    );

  test("exchanges a code for a token in the body", async () => {
    const verifier = randomId(48);
    const state = randomId(24);
    const redirectUri = "http://127.0.0.1:5000/cb";
    const requestId = await startRequest(
      db(),
      { userId: "u1", email: "u1@example.com" },
      { redirectUri, state, challenge: await s256(verifier), host: "mac" },
    );
    const a = await approveRequest(db(), { requestId, userId: "u1", state });
    if (!a.ok) throw new Error("approve failed");
    const r = await post({
      code: new URL(a.redirect).searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = await r.json();
    expect(j.token).toMatch(/^lk_/);
    expect(j.name).toBe("lianki CLI mac");

    // logout: the token revokes itself.
    const del = (auth?: string) =>
      DELETE(
        new Request("https://lianki.com/api/cli-login/token", {
          method: "DELETE",
          headers: auth ? { Authorization: auth } : {},
        }),
      );
    expect((await del()).status).toBe(401);
    expect((await del(`Bearer ${j.token}`)).status).toBe(200);
    expect((await del(`Bearer ${j.token}`)).status).toBe(404);
  });

  test("is rate-limited per IP", async () => {
    for (let i = 0; i < EXCHANGES_PER_IP.max; i++)
      expect((await post({ code: "x", code_verifier: "y" }, "203.0.113.9")).status).toBe(400);
    const r = await post({ code: "x", code_verifier: "y" }, "203.0.113.9");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post({ code: "x", code_verifier: "y" }, "203.0.113.10")).status).toBe(400);
  });

  test("a body that is not JSON is a bad request", async () => {
    const r = await POST(
      new Request("https://lianki.com/api/cli-login/token", { method: "POST", body: "{" }),
    );
    expect(r.status).toBe(400);
  });

  test("is shut on the Mongo rollback copy", async () => {
    useBackend("mongodb");
    expect((await post({})).status).toBe(503);
    expect(
      (await DELETE(new Request("https://lianki.com/api/cli-login/token", { method: "DELETE" })))
        .status,
    ).toBe(503);
  });
});

describe("the Bearer token reaches /api/prefs only", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  }

  test("apiTokenUser is used by app/api/prefs/route.ts and nothing else", () => {
    const users = [...files("app"), ...files("lib")].filter(
      (f) =>
        f !== join("lib", "api-token-user.ts") && /\bapiTokenUser\b/.test(readFileSync(f, "utf8")),
    );
    expect(users).toEqual([join("app", "api", "prefs", "route.ts")]);
  });

  test("the CLI login routes never accept a session for minting, nor a token for anything but itself", () => {
    const token = readFileSync("app/api/cli-login/token/route.ts", "utf8");
    expect(token).not.toMatch(/authUser|authEmail|getSession|apiTokenUser|authEmailOrToken/);
    const approve = readFileSync("app/api/cli-login/approve/route.ts", "utf8");
    expect(approve).toContain("sameOriginPost(req)");
    expect(approve).not.toMatch(/Authorization|apiTokenUser|authEmailOrToken/);
  });
});
