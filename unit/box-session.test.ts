/**
 * The box's signed-in view (docs/box-oauth.md, "The box's signed-in view"):
 * how the page learns who its token belongs to, the route that answers it, and
 * that one account's token can never read another's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { boxSessionFrom } from "@/lib/box-oauth/app-session";
import { boxGate, boxTokenHash, type GateDeps } from "@/lib/box-oauth/gate";
import { BOX_IDENTITY_HEADER, signBoxIdentity } from "@/lib/box-oauth/identity";
import { boxMeResponse } from "@/lib/box-oauth/me";
import { BOX_ME_PATH, tokenMayCall } from "@/lib/box-oauth/rules";
import { resolveBoxUser, type BoxSessionDeps } from "@/lib/box-oauth/session";
import { insertBinding, type BoxDb } from "@/lib/box-oauth/store";
import { signOut } from "@/lib/sign-out";

const BOX_A = "https://my-0123456789abcdef.lianki.com";
const BOX_B = "https://my-fedcba9876543210.lianki.com";
const SECRET = "y".repeat(40);
const TOKEN_A = `lkb_${"a".repeat(32)}`;
const TOKEN_B = `lkb_${"b".repeat(32)}`;
// The app checks the signed identity against the clock, so the gate signs with it too.
const NOW = Date.now();
const RW = ["box:read", "box:write"];

describe("the route is on the allowlist, read-only, and exactly one path", () => {
  test("GET and HEAD with either scope", () => {
    expect(tokenMayCall("GET", BOX_ME_PATH, ["box:read"])).toEqual({ ok: true });
    expect(tokenMayCall("HEAD", BOX_ME_PATH, RW)).toEqual({ ok: true });
  });
  test("no writes, even with box:write", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"])
      expect(tokenMayCall(m, BOX_ME_PATH, RW).ok).toBe(false);
  });
  test("nothing under it or beside it opens", () => {
    for (const p of ["/api/box/me/x", "/api/box", "/api/box/gate", "/api/box/mex"])
      expect(tokenMayCall("GET", p, RW).ok).toBe(false);
  });
  test("an uploaded avatar is readable, nothing writes there", () => {
    expect(tokenMayCall("GET", "/api/avatar/u1/0123456789abcdef0123", RW)).toEqual({ ok: true });
    expect(tokenMayCall("POST", "/api/avatar/u1/0123456789abcdef0123", RW).ok).toBe(false);
    expect(tokenMayCall("POST", "/api/profile/avatar", RW).ok).toBe(false);
  });
});

describe("the route's answer", () => {
  const user = { name: "Ann", email: "ann@test.example", image: null, id: "u1", role: "x" };
  test("no gate identity: 404, so lianki.com's own pages get nothing new", async () => {
    const res = await boxMeResponse(new Headers(), async () => ({ user }));
    expect(res.status).toBe(404);
  });
  test("only name, email and avatar, never cached", async () => {
    const res = await boxMeResponse(new Headers({ [BOX_IDENTITY_HEADER]: "x" }), async () => ({
      user,
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      user: { name: "Ann", email: "ann@test.example", image: null },
    });
  });
  test("a bad identity is nobody: 401", async () => {
    const res = await boxMeResponse(new Headers({ [BOX_IDENTITY_HEADER]: "x" }), async () => null);
    expect(res.status).toBe(401);
  });
});

describe("one account's token cannot read another's", () => {
  let db: TestD1Database;
  let saved: string | undefined;
  const deps: GateDeps = { flagOn: async () => true, allow: async () => true, now: () => NOW };
  const env = () => ({ DB: db as unknown as BoxDb, AUTH_SECRET: SECRET });
  // The app behind the gate: the route's own code, with the session read from this D1.
  const app = (r: Request) =>
    boxMeResponse(r.headers, (h) => boxSessionFrom(h, db as unknown as BoxDb));
  const call = (path: string, headers: Record<string, string>) =>
    boxGate(new Request(`https://lianki.com${path}`, { headers }), env(), deps, app);
  const email = async (res: Response) =>
    ((await res.json()) as { user?: { email?: string } }).user?.email;

  beforeAll(() => {
    saved = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = saved;
  });

  beforeEach(async () => {
    db = createTestD1(testSchema());
    const at = "2026-11-07T00:00:00.000Z";
    for (const id of ["u1", "u2"]) {
      await db
        .prepare(
          "INSERT INTO user (id, email, name, image, emailVerified, createdAt, updatedAt) VALUES (?1, ?2, ?3, NULL, 1, ?4, ?4)",
        )
        .bind(id, `${id}@test.example`, `Name ${id}`, at)
        .run();
    }
    for (const [client, origin, user, token] of [
      ["c1", BOX_A, "u1", TOKEN_A],
      ["c2", BOX_B, "u2", TOKEN_B],
    ] as const) {
      await db
        .prepare(
          "INSERT INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES (?1, ?1, '[]', ?2, ?2)",
        )
        .bind(client, at)
        .run();
      await insertBinding(
        db as unknown as BoxDb,
        { clientId: client, origin, userId: user, scopes: RW },
        "owner",
        NOW,
      );
      await db
        .prepare(
          "INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[\"box:read\"]')",
        )
        .bind(
          `t-${client}`,
          await boxTokenHash(token),
          client,
          user,
          new Date(NOW + 60_000).toISOString(),
          new Date(NOW).toISOString(),
        )
        .run();
    }
  });

  test("each token names its own account, and only that one", async () => {
    const a = await call(BOX_ME_PATH, { authorization: `Bearer ${TOKEN_A}`, origin: BOX_A });
    expect(a.status).toBe(200);
    expect(a.headers.get("access-control-allow-origin")).toBe(BOX_A);
    expect(await email(a)).toBe("u1@test.example");
    const b = await call(BOX_ME_PATH, { authorization: `Bearer ${TOKEN_B}`, origin: BOX_B });
    expect(await email(b)).toBe("u2@test.example");
  });

  test("asking for the other account changes nothing: the route takes no parameter", async () => {
    const res = await call(`${BOX_ME_PATH}?user=u2&email=u2@test.example`, {
      authorization: `Bearer ${TOKEN_A}`,
      origin: BOX_A,
    });
    expect(await email(res)).toBe("u1@test.example");
  });

  test("another box's token, from this box, is refused", async () => {
    const res = await call(BOX_ME_PATH, { authorization: `Bearer ${TOKEN_B}`, origin: BOX_A });
    expect(res.status).toBe(403);
  });

  test("a forged identity for the other account never reaches the route", async () => {
    const forged = await signBoxIdentity(SECRET, { userId: "u2", clientId: "c1" }, NOW);
    const res = await call(BOX_ME_PATH, {
      authorization: `Bearer ${TOKEN_A}`,
      origin: BOX_A,
      [BOX_IDENTITY_HEADER]: forged,
    });
    expect(await email(res)).toBe("u1@test.example");
    // Without a token, the gate strips it and the route sees no identity at all.
    const bare = await call(BOX_ME_PATH, { [BOX_IDENTITY_HEADER]: forged });
    expect(bare.status).toBe(404);
  });

  test("no token, a cookie, or an unknown token: nobody", async () => {
    expect((await call(BOX_ME_PATH, {})).status).toBe(404);
    expect(
      (
        await call(BOX_ME_PATH, {
          authorization: `Bearer ${TOKEN_A}`,
          origin: BOX_A,
          cookie: "__Host-better-auth.session_token=x",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(BOX_ME_PATH, { authorization: `Bearer lkb_${"c".repeat(32)}`, origin: BOX_A }))
        .status,
    ).toBe(401);
  });
});

describe("the box's page learns who it is", () => {
  function deps(over: Partial<BoxSessionDeps> & { answer?: () => Response } = {}) {
    const calls: string[] = [];
    let forgot = 0;
    const d: BoxSessionDeps = {
      hasTokens: () => true,
      forget: () => {
        forgot++;
      },
      fetch: async (url) => {
        calls.push(url);
        if (url.startsWith("/api/avatar/")) return new Response(new Blob(["png"]));
        return over.answer?.() ?? Response.json({ user: { name: "Ann", email: "a@test.example" } });
      },
      objectUrl: () => "blob:https://box.test/1",
      ...over,
    };
    return { d, calls, forgot: () => forgot };
  }

  test("no token in this tab: signed out, and lianki.com is not asked", async () => {
    const t = deps({ hasTokens: () => false });
    expect(await resolveBoxUser(t.d)).toBeNull();
    expect(t.calls).toEqual([]);
  });

  test("a token: the account from /api/box/me", async () => {
    const t = deps();
    expect(await resolveBoxUser(t.d)).toEqual({
      name: "Ann",
      email: "a@test.example",
      image: null,
    });
    expect(t.calls).toEqual([BOX_ME_PATH]);
  });

  test("refused tokens are forgotten, so /sign-in starts over", async () => {
    const t = deps({ answer: () => new Response("{}", { status: 401 }) });
    expect(await resolveBoxUser(t.d)).toBeNull();
    expect(t.forgot()).toBe(1);
  });

  test("lianki.com down: signed out for now, the tokens kept", async () => {
    for (const answer of [
      () => new Response("", { status: 503 }),
      () => new Response("not json"),
    ]) {
      const t = deps({ answer });
      expect(await resolveBoxUser(t.d)).toBeNull();
      expect(t.forgot()).toBe(0);
    }
    const offline = deps({
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    expect(await resolveBoxUser(offline.d)).toBeNull();
  });

  test("an uploaded avatar comes from lianki.com as a blob; a provider's picture as it is", async () => {
    const own = deps({
      answer: () =>
        Response.json({
          user: {
            name: "A",
            email: "a@test.example",
            image: "/api/avatar/u1/0123456789abcdef0123",
          },
        }),
    });
    expect((await resolveBoxUser(own.d))?.image).toBe("blob:https://box.test/1");
    expect(own.calls[1]).toBe("/api/avatar/u1/0123456789abcdef0123");
    const ext = deps({
      answer: () =>
        Response.json({
          user: { email: "a@test.example", image: "https://avatars.example.test/1" },
        }),
    });
    const u = await resolveBoxUser(ext.d);
    expect(u?.image).toBe("https://avatars.example.test/1");
    expect(u?.name).toBe("a@test.example");
    const odd = deps({
      answer: () => Response.json({ user: { email: "a@test.example", image: "javascript:1" } }),
    });
    expect((await resolveBoxUser(odd.d))?.image).toBeNull();
  });
});

describe("sign-out on a box", () => {
  test("revokes through the box instead of better-auth's cookie sign-out", async () => {
    const posts: string[] = [];
    const replaced: string[] = [];
    let ended = 0;
    const ok = await signOut("/", {
      fetch: async (url) => {
        posts.push(url);
        return new Response("{}");
      },
      replace: (u) => {
        replaced.push(u);
      },
      endSession: async () => {
        ended++;
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(ended).toBe(1);
    expect(posts).toEqual([]);
    expect(replaced).toEqual(["/"]);
  });
});
