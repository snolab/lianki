import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import type { D1Like, D1StmtLike } from "../lib/d1/types";
import { tokenScopeApi } from "../lib/api-token-scopes";
import {
  DEFAULT_TOKEN_SCOPES,
  checkToken,
  createToken,
  tokenScopeRequest,
} from "../lib/api-tokens";
import type { TokenApiDeps } from "../lib/api-token-api";

const now = Date.parse("2026-11-15T00:00:00Z");
const DAY = 86_400_000;
const owner = { userId: "u1", email: "u1@example.com" };
let db: TestD1Database;
let deps: TokenApiDeps;
let token: string;
let id: string;
const get = (tokenId = id, scope = "study") =>
  new Request(
    `https://lianki.com/api/token/scopes?id=${encodeURIComponent(tokenId)}&scope=${encodeURIComponent(scope)}`,
  );
const post = (body: unknown = { id, scope: "study" }, extra: Record<string, string> = {}) =>
  new Request("https://lianki.com/api/token/scopes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://lianki.com",
      "sec-fetch-site": "same-origin",
      ...extra,
    },
    body: JSON.stringify(body),
  });
const scopes = async () =>
  JSON.parse(
    (await db
      .prepare("SELECT scopes FROM api_tokens WHERE token_hash = ?")
      .bind(id)
      .first<{ scopes: string }>())!.scopes,
  );

beforeEach(async () => {
  db = createTestD1(testSchema());
  db.raw().exec(
    "INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES('u1','u1@example.com',1,'2026-11-01','2026-11-01'),('u2','u2@example.com',1,'2026-11-01','2026-11-01')",
  );
  const minted = await createToken(
    db as unknown as D1Like,
    owner,
    {
      name: "Fixture client",
      scopes: [...DEFAULT_TOKEN_SCOPES],
      expiresAt: new Date(now + 7 * DAY),
    },
    now,
  );
  token = minted.token;
  id = minted.id;
  deps = {
    who: async () => owner,
    db: () => db as unknown as ReturnType<TokenApiDeps["db"]>,
    revoked: async () => {},
    siteOwner: async () => false,
    now: () => now,
  };
});

function dev() {
  db.raw().exec(
    "INSERT INTO account_permission(email,permission,granted_by,granted_at) VALUES('u1@example.com','dev','fixture',1)",
  );
  deps.siteOwner = async () => true;
}
/** Deliberately interleave a concurrent mutation after metadata was read and before atomic approval. */
function beforeUpdate(change: () => void) {
  const wrap = (stmt: D1StmtLike): D1StmtLike => ({
    bind: (...values) => wrap(stmt.bind(...values)),
    first: async <T>() => {
      change();
      return stmt.first<T>();
    },
    all: <T>() => stmt.all<T>(),
    run: () => stmt.run(),
  });
  deps.db = () =>
    ({
      prepare: (sql: string) =>
        sql.startsWith("UPDATE api_tokens SET scopes") ? wrap(db.prepare(sql)) : db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
    }) as ReturnType<TokenApiDeps["db"]>;
}

describe("one explicit token scope approval", () => {
  test("defaults are chat-only and missing-scope errors contain only the public token id", async () => {
    expect(DEFAULT_TOKEN_SCOPES).toEqual(["chat:read", "chat:write", "chat:ask"]);
    const missing = await checkToken(db as unknown as D1Like, token, "study", now);
    expect(missing).toMatchObject({
      ok: false,
      reason: "scope",
      needScope: "study",
      requestUrl: `https://lianki.com/my/tokens/scopes?token=${id}&scope=study`,
    });
    expect(JSON.stringify(missing)).not.toContain(token);
    expect(tokenScopeRequest(id, "chat:ask")?.requestUrl).toEndWith("scope=chat%3Aask");
    for (const invalid of [token, "bad", null, "A".repeat(64)])
      expect(tokenScopeRequest(invalid, "study")).toBeNull();
    for (const invalid of ["admin", ["study", "eval"], null])
      expect(tokenScopeRequest(id, invalid)).toBeNull();
  });

  test("GET is read-only, POST appends one permission to the same token without extending expiry", async () => {
    const before = await scopes();
    const preview = await tokenScopeApi(get(), deps);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(await preview.json()).toEqual({
      token: {
        id,
        name: "Fixture client",
        scopes: before,
        expiresAt: new Date(now + 7 * DAY).toISOString(),
      },
      needScope: "study",
      granted: false,
      canApprove: true,
    });
    expect(await scopes()).toEqual(before);
    const approved = await tokenScopeApi(post(), deps);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      ok: true,
      token: {
        id,
        scopes: ["study", ...DEFAULT_TOKEN_SCOPES],
        expiresAt: new Date(now + 7 * DAY).toISOString(),
      },
    });
    expect((await checkToken(db as unknown as D1Like, token, "study", now)).ok).toBe(true);
    await tokenScopeApi(post(), deps);
    expect((await scopes()).filter((scope: string) => scope === "study")).toHaveLength(1);
    expect(await (await tokenScopeApi(get(), deps)).json()).toMatchObject({ granted: true });
    const audit = await db
      .prepare("SELECT kind,subject,detail FROM security_audit WHERE kind='api-token.scope'")
      .all<{ kind: string; subject: string; detail: string }>();
    expect(audit.results[0]).toEqual({
      kind: "api-token.scope",
      subject: id.slice(0, 16),
      detail: "study",
    });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  test("session ownership and live account/token are required; dead/revoked/foreign tokens never become live", async () => {
    deps.who = async () => null;
    expect((await tokenScopeApi(get(), deps)).status).toBe(401);
    expect((await tokenScopeApi(post(), deps)).status).toBe(401);
    deps.who = async () => ({ userId: "u2", email: "u2@example.com" });
    expect((await tokenScopeApi(get(), deps)).status).toBe(404);
    expect((await tokenScopeApi(post(), deps)).status).toBe(404);
    deps.who = async () => owner;
    expect((await tokenScopeApi(get(token), deps)).status).toBe(404);
    expect((await tokenScopeApi(get("f".repeat(64)), deps)).status).toBe(404);
    db.raw().prepare("UPDATE api_tokens SET expires_at = ?").run(new Date(now).toISOString());
    expect((await tokenScopeApi(get(), deps)).status).toBe(404);
    db.raw().prepare("UPDATE api_tokens SET expires_at = NULL").run();
    db.raw().prepare("DELETE FROM user WHERE id='u1'").run();
    expect((await tokenScopeApi(post(), deps)).status).toBe(404);
  });

  test("exactly one valid permission per CSRF-protected POST; malformed, bearer-only and cross-site attempts cannot grant", async () => {
    expect(
      (
        await tokenScopeApi(
          new Request("https://lianki.com/api/token/scopes", {
            method: "POST",
            headers: { origin: "https://lianki.com", "content-type": "application/json" },
            body: "{",
          }),
          deps,
        )
      ).status,
    ).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { id, scope: ["study", "eval"] },
      { id, scope: "study eval" },
      { id, scope: "admin" },
      { id, scope: "study", scopes: ["eval"] },
    ])
      expect((await tokenScopeApi(post(body), deps)).status).toBe(400);
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "content-type": "text/plain" },
    ] as Record<string, string>[])
      expect((await tokenScopeApi(post(undefined, headers), deps)).status).toBe(403);
    const bearer = new Request("https://lianki.com/api/token/scopes", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id, scope: "study" }),
    });
    expect((await tokenScopeApi(bearer, deps)).status).toBe(403);
    expect((await tokenScopeApi(new Request(get(), { method: "PUT" }), deps)).status).toBe(405);
    // DELETE exists (taking token:mint-child back) but is CSRF-guarded like POST.
    expect((await tokenScopeApi(new Request(get(), { method: "DELETE" }), deps)).status).toBe(403);
    expect((await tokenScopeApi(new Request(`${get().url}&scope=eval`), deps)).status).toBe(400);
    expect((await tokenScopeApi(get(id, "admin"), deps)).status).toBe(400);
    expect(await scopes()).toEqual(DEFAULT_TOKEN_SCOPES);
  });

  test("owner permissions require a live dev grant and capped expiry, never silently shortening or extending tokens", async () => {
    expect(await (await tokenScopeApi(get(id, "eval"), deps)).json()).toMatchObject({
      canApprove: false,
      error: "dev-required",
    });
    expect((await tokenScopeApi(post({ id, scope: "eval" }), deps)).status).toBe(403);
    dev();
    expect((await tokenScopeApi(post({ id, scope: "eval" }), deps)).status).toBe(200);
    db.raw()
      .prepare("UPDATE api_tokens SET expires_at = ?")
      .run(new Date(now + 90 * DAY).toISOString());
    expect(await (await tokenScopeApi(get(id, "recordings:read"), deps)).json()).toMatchObject({
      canApprove: false,
      error: "expiry-too-long",
    });
    expect((await tokenScopeApi(post({ id, scope: "recordings:read" }), deps)).status).toBe(403);
    db.raw().prepare("UPDATE api_tokens SET expires_at = NULL").run();
    expect((await tokenScopeApi(post({ id, scope: "eval" }), deps)).status).toBe(403);
    expect((await tokenScopeApi(post({ id, scope: "progress" }), deps)).status).toBe(200);
    deps.siteOwner = undefined;
    expect((await tokenScopeApi(post({ id, scope: "progress" }), deps)).status).toBe(403);
  });

  test("concurrent explicit approvals union rather than overwrite and never duplicate a scope", async () => {
    db.raw().prepare("UPDATE api_tokens SET scopes='[]'").run();
    const results = await Promise.all([
      tokenScopeApi(post({ id, scope: "study" }), deps),
      tokenScopeApi(post({ id, scope: "chat:read" }), deps),
      tokenScopeApi(post({ id, scope: "chat:read" }), deps),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(await scopes())).toEqual(new Set(["study", "chat:read"]));
    expect(await scopes()).toHaveLength(2);
    beforeUpdate(() => {
      db.raw().prepare("UPDATE api_tokens SET scopes=json_insert(scopes,'$[#]','chat:ask')").run();
    });
    expect((await tokenScopeApi(post({ id, scope: "chat:write" }), deps)).status).toBe(200);
    expect(new Set(await scopes())).toEqual(
      new Set(["study", "chat:read", "chat:write", "chat:ask"]),
    );
  });

  test("revocation, expiry, deletion and dev-loss races win against pending approval", async () => {
    beforeUpdate(() => {
      db.raw().prepare("DELETE FROM api_tokens WHERE token_hash=?").run(id);
    });
    expect((await tokenScopeApi(post(), deps)).status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM api_tokens").first<{ n: number }>()).toEqual(
      { n: 0 },
    );
  });

  test("atomic owner scope check rejects a dev grant revoked after the permission callback", async () => {
    dev();
    deps.siteOwner = async () => {
      db.raw().prepare("UPDATE account_permission SET revoked_at=?").run(now);
      return true;
    };
    expect((await tokenScopeApi(post({ id, scope: "eval" }), deps)).status).toBe(404);
    expect(await scopes()).toEqual(DEFAULT_TOKEN_SCOPES);
  });

  test("atomic expiry and account checks reject mutations after metadata was read", async () => {
    beforeUpdate(() => {
      db.raw()
        .prepare("UPDATE api_tokens SET expires_at=?")
        .run(new Date(now - 1).toISOString());
    });
    expect((await tokenScopeApi(post(), deps)).status).toBe(404);
    expect(await scopes()).toEqual(DEFAULT_TOKEN_SCOPES);
    db.raw().prepare("UPDATE api_tokens SET expires_at=NULL").run();
    beforeUpdate(() => {
      db.raw().prepare("DELETE FROM user WHERE id='u1'").run();
    });
    expect((await tokenScopeApi(post(), deps)).status).toBe(404);
  });

  test("legacy null scope grants preserve study; malformed stored JSON is fail-closed and safely repairable", async () => {
    db.raw().prepare("UPDATE api_tokens SET user_id=NULL,scopes=NULL,expires_at=NULL").run();
    expect((await tokenScopeApi(post({ id, scope: "chat:read" }), deps)).status).toBe(200);
    expect(await scopes()).toEqual(["study", "chat:read"]);
    for (const raw of ["not-json", "{}", "null"]) {
      db.raw().prepare("UPDATE api_tokens SET scopes=?").run(raw);
      expect((await tokenScopeApi(post({ id, scope: "chat:ask" }), deps)).status).toBe(200);
      expect(await scopes()).toEqual(["chat:ask"]);
    }
  });
});
