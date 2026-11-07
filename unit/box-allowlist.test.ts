/**
 * The one my-box allowlist (docs/box-oauth.md, "Who may have a box"): default
 * deny, owner-managed, the same list as custom frontends. Enforced at bind time
 * and at every use (gate, OAuth start, chat ticket, the hub's checks), audited,
 * and removing someone revokes their box.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { allowBoxUser, disallowBoxUser, listBoxAllowed } from "@/lib/box-oauth/allowlist";
import { chatTicketResponse } from "@/lib/box-oauth/chat-ticket";
import { boxGate, boxTokenHash, type GateDeps } from "@/lib/box-oauth/gate";
import { BOX_IDENTITY_HEADER, signBoxIdentity } from "@/lib/box-oauth/identity";
import {
  bindingByClient,
  bindingByOrigin,
  boxChatLive,
  boxEvalLive,
  insertBinding,
  isBoxAllowed,
  listBindings,
  liveToken,
  setBoxChat,
  setBoxEval,
  type BoxDb,
} from "@/lib/box-oauth/store";

const ORIGIN = "https://my-example.lianki.com";
const SECRET = "x".repeat(40);
const TOKEN = `lkb_${"a".repeat(32)}`;
const NOW = Date.parse("2026-11-08T00:00:00.000Z");
const RW = ["box:read", "box:write"];

let db: TestD1Database;
const box = () => db as unknown as BoxDb;

beforeEach(async () => {
  db = createTestD1(testSchema());
  const at = "2026-11-08T00:00:00.000Z";
  // owner: a site owner; member: an ordinary account, not on the list.
  for (const id of ["owner", "member"])
    await db
      .prepare(
        "INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES (?1, ?2, ?1, 1, ?3, ?3)",
      )
      .bind(id, `${id}@test.example`, at)
      .run();
  await db
    .prepare(
      "INSERT INTO site_role (email, role, granted_by, granted_at) VALUES ('owner@test.example', 'owner', 'test', 1)",
    )
    .run();
  for (const c of ["c1", "c2"])
    await db
      .prepare(
        "INSERT INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES (?1, ?1, '[]', ?2, ?2)",
      )
      .bind(c, at)
      .run();
});

const bindMember = () =>
  insertBinding(
    box(),
    { clientId: "c1", origin: ORIGIN, userId: "member", scopes: RW },
    "owner",
    NOW,
  );

async function addToken(clientId = "c1", userId = "member") {
  await db
    .prepare(
      "INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES ('t1', ?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(
      await boxTokenHash(TOKEN),
      clientId,
      userId,
      new Date(NOW + 60_000).toISOString(),
      new Date(NOW).toISOString(),
      '["box:read","box:write"]',
    )
    .run();
}

const kinds = async () =>
  (
    await db
      .prepare(
        "SELECT kind, subject FROM security_audit WHERE kind NOT LIKE 'site-role.%' ORDER BY id",
      )
      .all<{ kind: string; subject: string }>()
  ).results;

describe("who is on the list", () => {
  test("default deny: an ordinary account may not have a box", async () => {
    expect(await isBoxAllowed(box(), "member")).toBe(false);
    expect(await isBoxAllowed(box(), "nobody")).toBe(false);
  });

  test("a site owner approves the list and needs no row", async () => {
    expect(await isBoxAllowed(box(), "owner")).toBe(true);
    await db.prepare("UPDATE site_role SET revoked_at = 1").run();
    expect(await isBoxAllowed(box(), "owner")).toBe(false);
  });

  test("added by email or by user id, audited; an unknown one is refused", async () => {
    expect(await allowBoxUser(box(), "MEMBER@test.example", "owner", NOW)).toBe("member");
    expect(await isBoxAllowed(box(), "member")).toBe(true);
    expect(await allowBoxUser(box(), "owner", "owner", NOW)).toBe("owner");
    expect(await allowBoxUser(box(), "nobody@test.example", "owner", NOW)).toBeNull();
    expect(await allowBoxUser(box(), "nobody", "owner", NOW)).toBeNull();
    expect((await listBoxAllowed(box())).map((a) => a.userId).sort()).toEqual(["member", "owner"]);
    expect((await kinds()).map((k) => k.kind)).toEqual([
      "live-frontend.allow",
      "live-frontend.allow",
    ]);
  });
});

describe("at every use", () => {
  beforeEach(async () => {
    await bindMember();
    await addToken();
  });

  test("a binding whose account is off the list is no box", async () => {
    expect(await bindingByClient(box(), "c1")).toBeNull();
    expect(await bindingByOrigin(box(), ORIGIN)).toBeNull();
    expect(await liveToken(box(), await boxTokenHash(TOKEN), NOW)).toBeNull();
    const [row] = await listBindings(box());
    expect(row).toMatchObject({ clientId: "c1", allowed: false, revokedAt: null });
  });

  test("on the list, the same binding works", async () => {
    await allowBoxUser(box(), "member", "owner", NOW);
    expect((await bindingByClient(box(), "c1"))?.origin).toBe(ORIGIN);
    expect((await liveToken(box(), await boxTokenHash(TOKEN), NOW))?.userId).toBe("member");
    expect((await listBindings(box()))[0].allowed).toBe(true);
  });

  test("the gate: no CORS, no token, no code exchange off the list", async () => {
    let seen: Request | null = null;
    const deps: GateDeps = { flagOn: async () => true, allow: async () => true, now: () => NOW };
    const app = async (r: Request) => ((seen = r), new Response("ok"));
    const call = (path: string, init: RequestInit) =>
      boxGate(
        new Request(`https://lianki.com${path}`, init),
        { DB: box(), AUTH_SECRET: SECRET },
        deps,
        app,
      );
    expect(
      (await call("/api/prefs", { method: "OPTIONS", headers: { origin: ORIGIN } })).status,
    ).toBe(403);
    expect(
      (
        await call("/api/prefs", {
          headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/api/auth/oauth2/token", {
          method: "POST",
          headers: { origin: ORIGIN },
          body: "grant_type=x",
        })
      ).status,
    ).toBe(403);
    expect(seen).toBeNull();
    // On the list: through.
    await allowBoxUser(box(), "member", "owner", NOW);
    const ok = await call("/api/prefs", {
      headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
    });
    expect(ok.status).toBe(200);
    expect(seen).not.toBeNull();
  });
});

describe("a lookup that fails is closed, never through", () => {
  test("preflight, code exchange and token all refuse on a D1 error", async () => {
    await allowBoxUser(box(), "member", "owner", NOW);
    await bindMember();
    await addToken();
    const broken = {
      prepare: (sql: string) => {
        if (sql.includes("box_binding")) throw new Error("d1 down");
        return db.prepare(sql);
      },
    } as unknown as BoxDb;
    let seen: Request | null = null;
    const deps: GateDeps = { flagOn: async () => true, allow: async () => true, now: () => NOW };
    const call = (path: string, init: RequestInit) =>
      boxGate(
        new Request(`https://lianki.com${path}`, init),
        { DB: broken, AUTH_SECRET: SECRET },
        deps,
        async (r) => ((seen = r), new Response("ok")),
      );
    const pre = await call("/api/prefs", { method: "OPTIONS", headers: { origin: ORIGIN } });
    expect(pre.status).toBe(403);
    const code = await call("/api/auth/oauth2/token", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: "grant_type=x",
    });
    expect(code.status).toBe(403);
    const tok = await call("/api/prefs", {
      headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
    });
    expect(tok.status).toBe(401);
    expect(seen).toBeNull();
  });
});

describe("chat and eval read the list too", () => {
  test("a site owner's box: chat and eval live; a revoked role ends both", async () => {
    await insertBinding(
      box(),
      { clientId: "c2", origin: ORIGIN, userId: "owner", scopes: RW },
      "owner",
      NOW,
    );
    expect(await setBoxChat(box(), "c2", true, "owner", NOW)).toBe("granted");
    expect(await setBoxEval(box(), "c2", true, "owner", NOW)).toBe("granted");
    expect(await boxChatLive(box(), "c2")).toBe(true);
    expect(await boxEvalLive(box(), "c2")).toBe(true);
    await db.prepare("UPDATE site_role SET revoked_at = 1").run();
    expect(await boxChatLive(box(), "c2")).toBe(false);
    expect(await boxEvalLive(box(), "c2")).toBe(false);
  });

  test("the chat ticket: refused for a box off the list", async () => {
    await bindMember();
    await db.prepare("UPDATE box_binding SET scopes = 'box:read box:chat'").run();
    const headers = new Headers({
      [BOX_IDENTITY_HEADER]: await signBoxIdentity(
        SECRET,
        { userId: "member", clientId: "c1" },
        NOW,
      ),
    });
    const res = await chatTicketResponse(headers, {
      secret: SECRET,
      db: box(),
      sign: async () => ({ ticket: "t", exp: NOW + 60_000 }),
      allow: () => true,
      now: () => NOW,
    });
    expect(res.status).toBe(403);
  });
});

describe("taking someone off the list", () => {
  test("revokes their box and its tokens, stops their previews, all audited", async () => {
    await allowBoxUser(box(), "member", "owner", NOW);
    await bindMember();
    await addToken();
    await db
      .prepare(
        "INSERT INTO live_preview (id, user_id, target, created_at, expires_at) VALUES ('p1', 'member', 'https://x.trycloudflare.com', ?1, ?2)",
      )
      .bind(NOW, NOW + 3_600_000)
      .run();
    expect(await disallowBoxUser(box(), "member", "owner", NOW + 1)).toEqual({
      removed: true,
      revokedClientId: "c1",
    });
    expect(await isBoxAllowed(box(), "member")).toBe(false);
    const b = await db
      .prepare("SELECT revoked_at FROM box_binding WHERE client_id = 'c1'")
      .first<{ revoked_at: number | null }>();
    expect(b?.revoked_at).toBe(NOW + 1);
    const t = await db
      .prepare("SELECT revoked FROM oauthAccessToken WHERE id = 't1'")
      .first<{ revoked: string | null }>();
    expect(t?.revoked).not.toBeNull();
    const p = await db
      .prepare("SELECT revoked_at FROM live_preview WHERE id = 'p1'")
      .first<{ revoked_at: number | null }>();
    expect(p?.revoked_at).toBe(NOW + 1);
    expect((await kinds()).map((k) => k.kind)).toEqual([
      "live-frontend.allow",
      "box.bind",
      "live-frontend.disallow",
      "box.revoke",
    ]);
  });

  test("adding them back does not bring a revoked box back", async () => {
    await allowBoxUser(box(), "member", "owner", NOW);
    await bindMember();
    await disallowBoxUser(box(), "member", "owner", NOW);
    await allowBoxUser(box(), "member", "owner", NOW);
    expect(await bindingByClient(box(), "c1")).toBeNull();
  });

  test("an old binding made before the list still gets revoked", async () => {
    await bindMember();
    expect(await disallowBoxUser(box(), "member", "owner", NOW)).toEqual({
      removed: false,
      revokedClientId: "c1",
    });
  });

  test("someone with no box: nothing to revoke", async () => {
    await allowBoxUser(box(), "member", "owner", NOW);
    expect(await disallowBoxUser(box(), "member", "owner", NOW)).toEqual({
      removed: true,
      revokedClientId: null,
    });
  });
});
