import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import { tokenApi, type TokenApiDeps } from "../lib/api-token-api";
import { createToken, checkToken, cleanTokenName } from "../lib/api-tokens";
const owner = { userId: "u1", email: "u1@example.test" };
const now = Date.parse("2026-11-20T00:00:00Z");
let db: TestD1Database, deps: TokenApiDeps, id: string, secret: string;
const patch = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://lianki.com/api/token", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://lianki.com", ...headers },
    body: JSON.stringify(body),
  });
const row = () =>
  db
    .prepare("SELECT * FROM api_tokens WHERE token_hash = ?")
    .bind(id)
    .first<Record<string, unknown>>();
beforeEach(async () => {
  db = createTestD1(testSchema());
  db.raw().exec(
    "INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES('u1','u1@example.test',1,'2026-11-01','2026-11-01'),('u2','u2@example.test',1,'2026-11-01','2026-11-01')",
  );
  deps = {
    who: async () => owner,
    db: () => db as unknown as ReturnType<TokenApiDeps["db"]>,
    revoked: async () => {
      throw new Error("rename must not revoke");
    },
    now: () => now,
  };
  const minted = await createToken(
    db,
    owner,
    {
      name: "Fixture client",
      scopes: ["chat:read", "chat:write"],
      expiresAt: new Date(now + 86400000),
    },
    now,
  );
  id = minted.id;
  secret = minted.token;
});
describe("session token name-only PATCH", () => {
  it("renames atomically while preserving every other column and the same usable secret", async () => {
    const before = await row();
    const r = await tokenApi(patch({ id, name: "  Fixture renamed  " }), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, id, name: "Fixture renamed" });
    expect(await row()).toEqual({ ...before, name: "Fixture renamed" });
    const checked = await checkToken(db, secret, "chat:write", now);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.name).toBe("Fixture renamed");
    expect(
      await db
        .prepare("SELECT kind FROM security_audit WHERE kind = 'api-token.rename'")
        .first<{ kind: string }>(),
    ).toEqual({ kind: "api-token.rename" });
  });
  it("uses the same name cleaning as token creation, including Unicode length", async () => {
    const input = " \nFixture【新】\t name  ";
    const r = await tokenApi(patch({ id, name: input }), deps);
    expect(r.status).toBe(200);
    expect((await r.json()).name).toBe(cleanTokenName(input));
    expect((await tokenApi(patch({ id, name: "界".repeat(40) }), deps)).status).toBe(200);
    for (const name of ["", " ", "\n【】", "界".repeat(41), 1, null])
      expect((await tokenApi(patch({ id, name }), deps)).status).toBe(400);
  });
  it("cannot rename another account, a revoked/missing row, invalid id or an OAuth app token", async () => {
    const before = await row();
    deps.who = async () => ({ userId: "u2", email: "u2@example.test" });
    expect((await tokenApi(patch({ id, name: "Other" }), deps)).status).toBe(404);
    expect(await row()).toEqual(before);
    deps.who = async () => owner;
    for (const other of ["x", "a".repeat(64), null])
      expect((await tokenApi(patch({ id: other, name: "Other" }), deps)).status).toBe(404);
    db.raw()
      .prepare("UPDATE api_tokens SET oauth_grant_id = 'fixture-grant' WHERE token_hash = ?")
      .run(id);
    expect((await tokenApi(patch({ id, name: "Other" }), deps)).status).toBe(404);
  });
  it("retains legacy own-row matching without adopting another account", async () => {
    db.raw().prepare("UPDATE api_tokens SET user_id = NULL WHERE token_hash = ?").run(id);
    expect((await tokenApi(patch({ id, name: "Legacy renamed" }), deps)).status).toBe(200);
  });
  it("rejects missing sessions, cross-site writes, invalid JSON and non-name mutations", async () => {
    deps.who = async () => null;
    expect(
      (await tokenApi(patch({ id, name: "Other" }, { authorization: "Bearer synthetic" }), deps))
        .status,
    ).toBe(401);
    deps.who = async () => owner;
    for (const headers of [
      { origin: "https://other.test" },
      { "sec-fetch-site": "cross-site" },
      { "content-type": "text/plain" },
    ] as Record<string, string>[])
      expect((await tokenApi(patch({ id, name: "Other" }, headers), deps)).status).toBe(403);
    const before = await row();
    for (const extra of [
      { scopes: ["eval"] },
      { expiry: { days: 365 } },
      { token: "synthetic" },
      { userId: "u2" },
    ])
      expect((await tokenApi(patch({ id, name: "Other", ...extra }), deps)).status).toBe(400);
    for (const body of [null, [], { id }])
      expect((await tokenApi(patch(body), deps)).status).toBe(400);
    expect(await row()).toEqual(before);
  });
});
