// The Google connection (docs/connections.md): sealing, state + PKCE, the
// consent URL, Google's token answers, storage, refresh, disconnect, and the
// Drive export of a private doc.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { seal, sealKey, unseal } from "@/lib/connections/crypto";
import { connectionsOn } from "@/lib/connections/gate";
import { s256 } from "@/lib/cli-login";
import {
  CALLBACK_PATH,
  ConnectionError,
  DRIVE_FILE_SCOPE,
  STATE_TTL_MS,
  accessToken,
  authorizationUrl,
  checkState,
  disconnect,
  exchangeCode,
  forget,
  getConnection,
  googleConfig,
  grantedScopes,
  idClaims,
  newConnectState,
  pickerConfig,
  returnPath,
  revokeAtGoogle,
  saveConnection,
  sealState,
  siteOrigin,
  validCode,
  type Exchanged,
  type GoogleConfig,
} from "@/lib/connections/google";
import { driveExportUrl, driveMetaUrl, fetchDriveHtml } from "@/lib/gdoc/drive";
import { GdocError } from "@/lib/gdoc/fetch";

const SECRET = "s".repeat(40);
const OTHER = "o".repeat(40);
const CLIENT = "123456789012-abc.apps.googleusercontent.com";
const CFG: GoogleConfig = {
  clientId: CLIENT,
  clientSecret: "client-secret",
  redirectUri: `https://lianki.com${CALLBACK_PATH}`,
};
const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const T0 = Date.parse("2026-11-04T08:00:00Z");

const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (claims: Record<string, unknown>) => `h.${b64(claims)}.sig`;
const goodClaims = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  exp: T0 / 1000 + 3600,
  sub: "1234567890",
  email: "a@example.com",
  email_verified: true,
};

type Call = { url: string; init?: RequestInit };
function fakeFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    // As the Workers runtime does: only "follow" and "manual" exist there.
    if (init?.redirect === "error")
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    return answer(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const bodyOf = (c: Call) => new URLSearchParams(String(c.init?.body));

describe("sealing", () => {
  it("round-trips and binds its context", async () => {
    const k = await sealKey("google-refresh", SECRET);
    const sealed = await seal(k, "refresh-token-value", "user-1");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("refresh-token-value");
    expect(await unseal(k, sealed, "user-1")).toBe("refresh-token-value");
    // Another row's AAD, another purpose's key, another secret: nothing opens.
    expect(await unseal(k, sealed, "user-2")).toBeNull();
    expect(await unseal(await sealKey("google-oauth-state", SECRET), sealed, "user-1")).toBeNull();
    expect(await unseal(await sealKey("google-refresh", OTHER), sealed, "user-1")).toBeNull();
    // Fresh IV each time.
    expect(await seal(k, "x", "u")).not.toBe(await seal(k, "x", "u"));
  });

  it("refuses tampered or malformed input", async () => {
    const k = await sealKey("google-refresh", SECRET);
    const sealed = await seal(k, "abc", "u");
    const [v, iv, ct] = sealed.split(".");
    const flip = ct.slice(0, -2) + (ct.at(-2) === "A" ? "B" : "A") + ct.at(-1);
    for (const bad of [
      `${v}.${iv}.${flip}`,
      `v2.${iv}.${ct}`,
      `${v}.${iv}`,
      `${sealed}.x`,
      `${v}.@@.${ct}`,
      `${v}.${iv.slice(2)}.${ct}`,
      `${v}.${iv}.AAAA`,
      "",
      "x".repeat(20_000),
    ])
      expect(await unseal(k, bad, "u")).toBeNull();
    expect(await unseal(k, 42 as unknown as string, "u")).toBeNull();
  });

  it("needs AUTH_SECRET", () => {
    expect(() => sealKey("google-refresh", undefined)).toThrow();
    expect(() => sealKey("google-refresh", "short")).toThrow();
  });
});

describe("config", () => {
  it("reuses the sign-in client and the site origin", () => {
    const env = {
      AUTH_GOOGLE_ID: CLIENT,
      AUTH_GOOGLE_SECRET: "x",
      BETTER_AUTH_BASE_URL: "https://lianki.com",
    };
    expect(googleConfig(env)).toEqual({
      clientId: CLIENT,
      clientSecret: "x",
      redirectUri: "https://lianki.com/api/connections/google/callback",
    });
    expect(googleConfig({ ...env, AUTH_GOOGLE_SECRET: "" })).toBeNull();
    expect(googleConfig({ AUTH_GOOGLE_ID: CLIENT, AUTH_GOOGLE_SECRET: "x" })).toBeNull();
    expect(siteOrigin({}, "http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(siteOrigin({}, "http://evil.example/x")).toBeNull();
    expect(siteOrigin({ BETTER_AUTH_BASE_URL: "not a url" })).toBeNull();
  });

  it("finds the Picker key and the project number", () => {
    const key = "AIza" + "x".repeat(35);
    expect(pickerConfig({})).toBeNull();
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: "bad key!" })).toBeNull();
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: key, AUTH_GOOGLE_ID: CLIENT })).toEqual({
      apiKey: key,
      appId: "123456789012",
    });
    expect(
      pickerConfig({
        GOOGLE_PICKER_API_KEY: key,
        AUTH_GOOGLE_ID: CLIENT,
        GOOGLE_PICKER_APP_ID: "999999",
      })?.appId,
    ).toBe("999999");
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: key, AUTH_GOOGLE_ID: "abc" })).toBeNull();
  });

  it("gates on the flag or the owner", () => {
    expect(connectionsOn({}, false)).toBe(false);
    expect(connectionsOn(null, true)).toBe(true);
    expect(connectionsOn({ "connections.google": true }, false)).toBe(true);
  });
});

describe("state and PKCE", () => {
  it("makes an S256 pair inside RFC 7636's limits", async () => {
    const { state, challenge } = await newConnectState("u1", "/reader", T0);
    expect(state.v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(await s256(state.v));
    expect(state.e).toBe(T0 + STATE_TTL_MS);
    expect(state.r).toBe("/reader");
  });

  it("accepts its own cookie only, for its user, in time, with the same state", async () => {
    const { state } = await newConnectState("u1", "/connections", T0);
    const cookie = await sealState(state, SECRET);
    expect(await checkState(cookie, state.s, "u1", SECRET, T0 + 1000)).toEqual({ ok: true, state });
    const bad = { ok: false, error: "bad-state" } as const;
    expect(await checkState(cookie, state.s, "u2", SECRET, T0)).toEqual(bad);
    expect(await checkState(cookie, state.s, "u1", SECRET, T0 + STATE_TTL_MS)).toEqual(bad);
    expect(await checkState(cookie, state.s.replace(/.$/, "x"), "u1", SECRET, T0)).toEqual(bad);
    expect(await checkState(cookie, "short", "u1", SECRET, T0)).toEqual(bad);
    expect(await checkState(undefined, state.s, "u1", SECRET, T0)).toEqual(bad);
    expect(await checkState(cookie, state.s, "u1", OTHER, T0)).toEqual(bad);
    // A cookie whose content is not a state, sealed with the right key.
    const k = await sealKey("google-oauth-state", SECRET);
    expect(
      await checkState(
        await seal(k, "not json", "google-oauth-state:u1"),
        state.s,
        "u1",
        SECRET,
        T0,
      ),
    ).toEqual(bad);
    expect(
      await checkState(
        await seal(k, JSON.stringify({ ...state, u: "u2" }), "google-oauth-state:u1"),
        state.s,
        "u1",
        SECRET,
        T0,
      ),
    ).toEqual(bad);
  });

  it("returns only to our own pages", () => {
    expect(returnPath("/reader")).toBe("/reader");
    expect(returnPath(`/reader?gdoc=${DOC}`)).toBe(`/reader?gdoc=${DOC}`);
    // A connection started on the old /read (before 2026-11-09) comes back to /reader.
    expect(returnPath("/read")).toBe("/reader");
    expect(returnPath("/read?pick=drive")).toBe("/reader?pick=drive");
    expect(returnPath(`/read?gdoc=${DOC}`)).toBe(`/reader?gdoc=${DOC}`);
    expect(returnPath("/reading")).toBe("/connections");
    for (const bad of ["https://evil.example", "//evil.example", "/reader?gdoc=x", "/admin", 7])
      expect(returnPath(bad)).toBe("/connections");
  });

  it("asks Google for drive.file offline, PKCE, and never incremental scopes", () => {
    const u = new URL(authorizationUrl(CFG, "st", "ch", "a@example.com"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({
      client_id: CLIENT,
      redirect_uri: CFG.redirectUri,
      response_type: "code",
      scope: `openid email ${DRIVE_FILE_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      login_hint: "a@example.com",
    });
    expect(u.searchParams.has("include_granted_scopes")).toBe(false);
    expect(new URL(authorizationUrl(CFG, "st", "ch", "no at")).searchParams.has("login_hint")).toBe(
      false,
    );
  });

  it("checks codes", () => {
    expect(validCode("4/0AbCdEf-gh_ij.kl~mn")).toBe(true);
    expect(validCode("short")).toBe(false);
    expect(validCode("has space here")).toBe(false);
    expect(validCode(undefined)).toBe(false);
  });
});

describe("Google's answers", () => {
  it("reads the id token's claims", () => {
    expect(idClaims(idToken(goodClaims), CLIENT, T0)).toEqual({
      sub: "1234567890",
      email: "a@example.com",
    });
    expect(
      idClaims(idToken({ ...goodClaims, email_verified: false }), CLIENT, T0)?.email,
    ).toBeNull();
    for (const bad of [
      { ...goodClaims, iss: "https://evil.example" },
      { ...goodClaims, aud: "other" },
      { ...goodClaims, exp: T0 / 1000 - 3600 },
      { ...goodClaims, sub: "x y" },
    ])
      expect(idClaims(idToken(bad), CLIENT, T0)).toBeNull();
    expect(idClaims("a.b", CLIENT, T0)).toBeNull();
    expect(idClaims("a.%%%.c", CLIENT, T0)).toBeNull();
    expect(idClaims(undefined, CLIENT, T0)).toBeNull();
  });

  it("parses granted scopes", () => {
    expect(grantedScopes(`openid  email ${DRIVE_FILE_SCOPE} email`)).toEqual([
      "openid",
      "email",
      DRIVE_FILE_SCOPE,
    ]);
    expect(grantedScopes(undefined)).toEqual([]);
  });

  it("exchanges a code with its verifier", async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        access_token: "at",
        expires_in: 3599,
        refresh_token: "rt",
        scope: `openid email ${DRIVE_FILE_SCOPE}`,
        id_token: idToken(goodClaims),
      }),
    );
    const ex = await exchangeCode(CFG, "code-12345", "verifier", f, T0);
    expect(ex).toEqual({
      accessToken: "at",
      expiresAt: T0 + 3599_000,
      refreshToken: "rt",
      scopes: ["openid", "email", DRIVE_FILE_SCOPE],
      claims: { sub: "1234567890", email: "a@example.com" },
    });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(bodyOf(calls[0]))).toEqual({
      grant_type: "authorization_code",
      code: "code-12345",
      code_verifier: "verifier",
      client_id: CLIENT,
      client_secret: "client-secret",
      redirect_uri: CFG.redirectUri,
    });
    // The Workers runtime throws on redirect "error" (every connect failed, 2026-11-05).
    expect(["follow", "manual"]).toContain(calls[0].init?.redirect as string);
    const refused = await exchangeCode(
      CFG,
      "c",
      "v",
      fakeFetch(() => json({ error: "invalid_grant", error_description: "Bad code x" }, 400)).f,
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectionError);
    expect((refused as ConnectionError).code).toBe("google-failed");
    // The log detail carries Google's error word and the step, never its text.
    expect((refused as ConnectionError).detail).toEqual({
      step: "token",
      status: 400,
      google: "invalid_grant",
    });
    // A redirect from the token endpoint is a failure, not followed.
    await expect(
      exchangeCode(CFG, "c", "v", fakeFetch(() => new Response(null, { status: 302 })).f),
    ).rejects.toThrow("google-failed");
    await expect(
      exchangeCode(CFG, "c", "v", fakeFetch(() => json({ access_token: "at" })).f),
    ).rejects.toThrow("google-failed");
  });

  it("revokes, counting an already-dead token as done", async () => {
    const { f, calls } = fakeFetch(() => json({}, 200));
    expect(await revokeAtGoogle("rt", f)).toBe(true);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(bodyOf(calls[0]).get("token")).toBe("rt");
    expect(
      await revokeAtGoogle("rt", fakeFetch(() => json({ error: "invalid_token" }, 400)).f),
    ).toBe(true);
    expect(await revokeAtGoogle("rt", fakeFetch(() => json({}, 503)).f)).toBe(false);
    const throws = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    expect(await revokeAtGoogle("rt", throws)).toBe(false);
  });
});

describe("storage, refresh, disconnect", () => {
  let d1: TestD1Database;
  const db = () => d1 as unknown as D1Like;
  const ex = (over: Partial<Exchanged> = {}): Exchanged => ({
    accessToken: "at-1",
    expiresAt: T0 + 3600_000,
    refreshToken: "rt-1",
    scopes: ["openid", "email", DRIVE_FILE_SCOPE],
    claims: { sub: "1234567890", email: "a@example.com" },
    ...over,
  });

  beforeEach(() => {
    d1 = createTestD1(testSchema());
    d1.exec(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1','U','u@example.com',1,'2026-01-01','2026-01-01')",
    );
    forget("u1");
  });

  const row = () =>
    d1.prepare("SELECT * FROM connection WHERE user_id = 'u1'").first<Record<string, unknown>>();

  it("stores the refresh token sealed, never the access token", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    const r = (await row())!;
    expect(String(r.refresh_enc)).toMatch(/^v1\./);
    expect(JSON.stringify(r)).not.toContain("rt-1");
    expect(JSON.stringify(r)).not.toContain("at-1");
    expect(await getConnection(db(), "u1")).toEqual({
      provider: "google",
      email: "a@example.com",
      scopes: ["openid", "email", DRIVE_FILE_SCOPE],
      status: "ok",
      createdMs: T0,
      updatedMs: T0,
    });
    expect(await getConnection(db(), "nobody")).toBeNull();
  });

  it("keeps the old refresh token only for the same Google account", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    const before = (await row())!.refresh_enc;
    await saveConnection(db(), "u1", ex({ refreshToken: null }), SECRET, T0 + 1);
    expect((await row())!.refresh_enc).toBe(before);
    await expect(
      saveConnection(
        db(),
        "u1",
        ex({ refreshToken: null, claims: { sub: "999", email: null } }),
        SECRET,
        T0 + 2,
      ),
    ).rejects.toThrow("google-failed");
  });

  it("serves the cached access token, then refreshes", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    const none = fakeFetch(() => {
      throw new Error("no call expected");
    });
    expect(await accessToken(db(), "u1", CFG, SECRET, none.f, T0)).toEqual({
      token: "at-1",
      expiresAt: T0 + 3600_000,
    });
    const { f, calls } = fakeFetch(() =>
      json({ access_token: "at-2", expires_in: 3600, refresh_token: "rt-2" }),
    );
    const later = T0 + 3600_000;
    expect((await accessToken(db(), "u1", CFG, SECRET, f, later)).token).toBe("at-2");
    expect(Object.fromEntries(bodyOf(calls[0]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: CLIENT,
      client_secret: "client-secret",
    });
    // Google rotated the refresh token: the new one is stored.
    forget("u1");
    const again = fakeFetch(() => json({ access_token: "at-3", expires_in: 3600 }));
    await accessToken(db(), "u1", CFG, SECRET, again.f, later);
    expect(bodyOf(again.calls[0]).get("refresh_token")).toBe("rt-2");
  });

  it("marks the connection for reconnect when Google refuses the grant", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    forget("u1");
    const refused = fakeFetch(() => json({ error: "invalid_grant" }, 400));
    await expect(accessToken(db(), "u1", CFG, SECRET, refused.f, T0)).rejects.toThrow("reconnect");
    expect((await getConnection(db(), "u1"))?.status).toBe("reconnect");
    await expect(accessToken(db(), "u1", CFG, SECRET, refused.f, T0)).rejects.toThrow("reconnect");
  });

  it("marks for reconnect when the sealed token no longer opens (AUTH_SECRET rotated)", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    forget("u1");
    const none = fakeFetch(() => json({}));
    await expect(accessToken(db(), "u1", CFG, OTHER, none.f, T0)).rejects.toThrow("reconnect");
    expect(none.calls.length).toBe(0);
    expect((await getConnection(db(), "u1"))?.status).toBe("reconnect");
  });

  it("refuses without a connection, without drive.file, or when Google fails", async () => {
    const none = fakeFetch(() => json({}));
    await expect(accessToken(db(), "u1", CFG, SECRET, none.f, T0)).rejects.toThrow("not-connected");
    await saveConnection(db(), "u1", ex({ scopes: ["openid", "email"] }), SECRET, T0);
    await expect(accessToken(db(), "u1", CFG, SECRET, none.f, T0)).rejects.toThrow(
      "no-drive-scope",
    );
    forget("u1");
    await expect(accessToken(db(), "u1", CFG, SECRET, none.f, T0)).rejects.toThrow(
      "no-drive-scope",
    );
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    forget("u1");
    await expect(
      accessToken(db(), "u1", CFG, SECRET, fakeFetch(() => json({}, 500)).f, T0),
    ).rejects.toThrow("google-failed");
    const throws = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    await expect(accessToken(db(), "u1", CFG, SECRET, throws, T0)).rejects.toThrow("google-failed");
    const narrowed = fakeFetch(() => json({ access_token: "at", scope: "openid" }));
    await expect(accessToken(db(), "u1", CFG, SECRET, narrowed.f, T0)).rejects.toThrow(
      "no-drive-scope",
    );
  });

  it("disconnect revokes at Google and deletes the row", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    const { f, calls } = fakeFetch(() => json({}));
    expect(await disconnect(db(), "u1", SECRET, f)).toEqual({ deleted: true, revoked: true });
    expect(bodyOf(calls[0]).get("token")).toBe("rt-1");
    expect(await row()).toBeNull();
    // The cached access token is gone with it.
    await expect(accessToken(db(), "u1", CFG, SECRET, f, T0)).rejects.toThrow("not-connected");
    // Nothing to disconnect: nothing sent to Google.
    const idle = fakeFetch(() => json({}));
    expect(await disconnect(db(), "u1", SECRET, idle.f)).toEqual({
      deleted: false,
      revoked: false,
    });
    expect(idle.calls.length).toBe(0);
  });

  it("deleting the user deletes the connection", async () => {
    await saveConnection(db(), "u1", ex(), SECRET, T0);
    d1.exec("PRAGMA foreign_keys = ON; DELETE FROM user WHERE id = 'u1';");
    expect(await row()).toBeNull();
  });

  it("ConnectionError carries its code", () => {
    const e = new ConnectionError("reconnect");
    expect(e.code).toBe("reconnect");
    expect(e.name).toBe("ConnectionError");
  });
});

describe("Drive export of a private doc", () => {
  const html = (s: string) =>
    new Response(s, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

  it("builds Drive URLs from a checked id only", () => {
    expect(driveMetaUrl(DOC)).toBe(
      `https://www.googleapis.com/drive/v3/files/${DOC}?fields=name%2CmimeType&supportsAllDrives=true`,
    );
    expect(driveExportUrl(DOC)).toBe(
      `https://www.googleapis.com/drive/v3/files/${DOC}/export?mimeType=text%2Fhtml`,
    );
    for (const bad of ["../x", "a".repeat(10), `${DOC}?x=1`, "evil.example/" + DOC]) {
      expect(() => driveMetaUrl(bad)).toThrow(GdocError);
      expect(() => driveExportUrl(bad)).toThrow(GdocError);
    }
  });

  it("checks the type, then exports HTML with the user's token", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.includes("/export")
        ? html(`<p>Hi</p><img src="data:image/png;base64,${"A".repeat(500)}">`)
        : json({ name: " My doc ", mimeType: "application/vnd.google-apps.document" }),
    );
    expect(await fetchDriveHtml(DOC, "tok", f)).toEqual({
      html: '<p>Hi</p><img src="">',
      title: "My doc",
    });
    expect(calls.map((c) => new Headers(c.init?.headers).get("authorization"))).toEqual([
      "Bearer tok",
      "Bearer tok",
    ]);
    expect(calls.every((c) => c.init?.redirect === "manual")).toBe(true);
    expect(calls.every((c) => c.url.startsWith("https://www.googleapis.com/drive/v3/files/"))).toBe(
      true,
    );
  });

  const errOf = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );

  it("maps Drive's answers", async () => {
    const meta = (r: Response) => fakeFetch(() => r).f;
    const driveErr = (status: number, reason: string) =>
      json({ error: { errors: [{ reason }] } }, status);
    expect(await errOf(fetchDriveHtml(DOC, "t", meta(driveErr(404, "notFound"))))).toBe(
      "not-granted",
    );
    expect(await errOf(fetchDriveHtml(DOC, "t", meta(driveErr(403, "forbidden"))))).toBe(
      "not-granted",
    );
    expect(await errOf(fetchDriveHtml(DOC, "t", meta(driveErr(401, "authError"))))).toBe(
      "reconnect",
    );
    expect(
      await errOf(fetchDriveHtml(DOC, "t", meta(driveErr(403, "insufficientPermissions")))),
    ).toBe("no-drive-scope");
    expect(
      await errOf(fetchDriveHtml(DOC, "t", meta(driveErr(403, "userRateLimitExceeded")))),
    ).toBe("fetch-failed");
    expect(await errOf(fetchDriveHtml(DOC, "t", meta(new Response("x", { status: 500 }))))).toBe(
      "fetch-failed",
    );
    expect(
      await errOf(fetchDriveHtml(DOC, "t", meta(json({ mimeType: "application/pdf", name: "x" })))),
    ).toBe("not-found");
    expect(await errOf(fetchDriveHtml(DOC, "t", meta(new Response("not json"))))).toBe("not-found");
    const throws = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    expect(await errOf(fetchDriveHtml(DOC, "t", throws))).toBe("fetch-failed");

    const docMeta = json({ mimeType: "application/vnd.google-apps.document" });
    const tooBig = fakeFetch((url) =>
      url.includes("/export") ? driveErr(403, "exportSizeLimitExceeded") : docMeta.clone(),
    );
    expect(await errOf(fetchDriveHtml(DOC, "t", tooBig.f))).toBe("too-large");
    const notHtml = fakeFetch((url) =>
      url.includes("/export") ? json({ x: 1 }) : docMeta.clone(),
    );
    expect(await errOf(fetchDriveHtml(DOC, "t", notHtml.f))).toBe("fetch-failed");
    const untitled = fakeFetch((url) =>
      url.includes("/export") ? html("<p>x</p>") : docMeta.clone(),
    );
    expect((await fetchDriveHtml(DOC, "t", untitled.f)).title).toBeNull();
  });
});
