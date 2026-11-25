import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "../lib/d1/testDb";
import { testSchema } from "../lib/d1/testSchema";
import type { D1Like } from "../lib/d1/types";
import {
  CHILD_DEFAULTS,
  type ChildApiDeps,
  childApi,
  cleanChildName,
} from "../lib/api-token-child";
import {
  MINT_CHILD,
  type ScopeId,
  checkToken,
  createToken,
  describeToken,
} from "../lib/api-tokens";
import { type TokenApiDeps, tokenApi } from "../lib/api-token-api";
import { tokenScopeApi } from "../lib/api-token-scopes";
import { FLAGS } from "../lib/flags";
import { childIndex, childLane, childShownName } from "../packages/debug-chat/src/child-lane";
import { lineAvatar } from "../packages/debug-chat/src/avatar-rules";
import type { ChatMessage } from "../packages/debug-chat/src/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LineTag, childAvatar } from "../packages/debug-chat/src/LaneMark";

// Fixtures only: fake accounts, fake tokens.
const now = Date.parse("2026-11-25T00:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const owner = { userId: "u1", email: "u1@example.com" };
let db: TestD1Database;
let parent: string;
let parentId: string;
let revoked: string[];
let deps: ChildApiDeps;

const D = () => db as unknown as D1Like & ReturnType<ChildApiDeps["db"]>;

async function mintParent(scopes: ScopeId[], days = 7, name = "claude") {
  const t = await createToken(
    db as unknown as D1Like,
    owner,
    { name, scopes, expiresAt: new Date(now + days * DAY) },
    now,
  );
  return t;
}
const flag = (on: boolean) =>
  db
    .raw()
    .exec(
      `INSERT OR REPLACE INTO feature_flags(key,enabled,updated_at,updated_by) VALUES('tokens.child',${on ? 1 : 0},'2026-11-25','fixture')`,
    );
const req = (method: string, body?: unknown, token = parent) =>
  new Request("https://lianki.com/api/token/child", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const mint = async (body: Record<string, unknown>, token = parent) => {
  const r = await childApi(req("POST", body, token), deps);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const audits = () =>
  db.raw().prepare("SELECT kind, actor, subject, detail FROM security_audit ORDER BY id").all() as {
    kind: string;
    actor: string;
    subject: string;
    detail: string;
  }[];

beforeEach(async () => {
  db = createTestD1(testSchema());
  db.raw().exec(
    "INSERT INTO user(id,email,emailVerified,createdAt,updatedAt) VALUES('u1','u1@example.com',1,'2026-11-01','2026-11-01')",
  );
  flag(true);
  const p = await mintParent(["chat:read", "chat:write", "chat:ask", MINT_CHILD]);
  parent = p.token;
  parentId = p.id;
  revoked = [];
  deps = {
    db: D,
    enabled: async () => true,
    siteOwner: async () => true,
    limits: async () => CHILD_DEFAULTS,
    revoked: async (ids) => {
      revoked.push(...ids);
    },
    now: () => now,
  };
});

describe("minting", () => {
  test("a child is named <parent>·<sub>, gets the default scopes and expiry, and works for chat", async () => {
    const r = await mint({ name: "子1" });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("claude·子1");
    expect(r.body.scopes).toEqual(["chat:read", "chat:write"]);
    expect(r.body.expiresAt).toBe(
      new Date(now + CHILD_DEFAULTS.defaultMinutes * MIN).toISOString(),
    );
    expect(String(r.body.token)).toMatch(/^lk_[0-9a-f]{64}$/);
    const c = await checkToken(D(), r.body.token, "chat:write", now);
    expect(c.ok && c.name).toBe("claude·子1");
    expect(c.ok && c.parentId).toBe(parentId);
  });

  test("scopes must be a subset of the parent's", async () => {
    const r = await mint({ name: "子1", scopes: ["chat:read", "study"] });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("not held by the parent: study");
    expect(await mint({ name: "子1", scopes: ["chat:ask"] })).toMatchObject({ status: 200 });
  });

  test("no grandchildren: a child never gets token:mint-child, and a child token cannot mint", async () => {
    const r = await mint({ name: "子1", scopes: ["chat:read", MINT_CHILD] });
    expect(r.status).toBe(400);
    const ok = await mint({ name: "子2" });
    // Even a child row holding the scope (written by hand) is refused as a parent.
    db.raw()
      .prepare("UPDATE api_tokens SET scopes = ? WHERE token_hash = ?")
      .run(JSON.stringify(["chat:read", MINT_CHILD]), ok.body.id as string);
    const g = await mint({ name: "孙" }, ok.body.token as string);
    expect(g.status).toBe(403);
    // and its effective scopes never include the permission
    const c = await checkToken(D(), ok.body.token, "chat:read", now);
    expect(c.ok && c.scopes).toEqual(["chat:read"]);
  });

  test("expiry is capped by the parent's", async () => {
    // Parent ends in 2 h: the 4 h default is clamped, an explicit 3 h refused.
    db.raw()
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(now + 120 * MIN).toISOString(), parentId);
    const d = await mint({ name: "子1" });
    expect(d.body.expiresAt).toBe(new Date(now + 120 * MIN).toISOString());
    const x = await mint({ name: "子2", ttlMinutes: 180 });
    expect(x.status).toBe(400);
    expect(String(x.body.error)).toContain("parent");
    expect((await mint({ name: "子3", ttlMinutes: 60 })).status).toBe(200);
    expect((await mint({ name: "子4", ttlMinutes: CHILD_DEFAULTS.maxMinutes + 1 })).status).toBe(
      400,
    );
  });

  test("at most maxLive live children per parent, live names unique", async () => {
    deps.limits = async () => ({ ...CHILD_DEFAULTS, maxLive: 2 });
    expect((await mint({ name: "a1" })).status).toBe(200);
    expect((await mint({ name: "a1" })).status).toBe(409);
    expect((await mint({ name: "a2" })).status).toBe(200);
    const third = await mint({ name: "a3" });
    expect(third.status).toBe(409);
    expect(String(third.body.error)).toContain("Too many");
  });

  test("concurrent mints: one live slot lets only one through", async () => {
    deps.limits = async () => ({ ...CHILD_DEFAULTS, maxLive: 1 });
    const rs = await Promise.all([
      mint({ name: "a1" }),
      mint({ name: "a2" }),
      mint({ name: "a3" }),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    const n = db
      .raw()
      .prepare("SELECT count(*) AS n FROM api_tokens WHERE parent_hash = ?")
      .get(parentId) as { n: number };
    expect(n.n).toBe(1);
  });

  test("concurrent mints: one live name is taken once", async () => {
    const rs = await Promise.all([
      mint({ name: "a1" }),
      mint({ name: "a1" }),
      mint({ name: "a1" }),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const refused = rs.filter((r) => r.status === 409);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(String(r.body.error)).toContain("a live child has it");
  });

  test("an expired child frees its slot and its name", async () => {
    deps.limits = async () => ({ ...CHILD_DEFAULTS, maxLive: 1 });
    expect((await mint({ name: "a1", ttlMinutes: 5 })).status).toBe(200);
    expect((await mint({ name: "a1" })).status).toBe(409);
    deps.now = () => now + 6 * MIN;
    expect((await mint({ name: "a1" })).status).toBe(200);
  });

  test("the parent needs token:mint-child and a dev account", async () => {
    const plain = await mintParent(["chat:read", "chat:write"], 7, "codex");
    expect((await mint({ name: "子1" }, plain.token)).status).toBe(403);
    deps.siteOwner = async () => false;
    expect((await mint({ name: "子1" })).status).toBe(403);
  });

  test("bad names are refused", () => {
    for (const bad of [
      "codex",
      "小克",
      "owner",
      "Owner",
      "admin",
      "【x】",
      "a·b",
      "x".repeat(13),
      "",
      "  ",
    ])
      expect(cleanChildName(bad)).toBeNull();
    expect(cleanChildName("子1")).toBe("子1");
    expect(cleanChildName("reviewer")).toBe("reviewer");
  });
});

describe("the route's edges", () => {
  test("list, bad requests, refused callers", async () => {
    const a = await mint({ name: "子1" });
    const l = (await (await childApi(req("GET"), deps)).json()) as { children: { id: string }[] };
    expect(l.children.map((c) => c.id)).toEqual([a.body.id as string]);
    expect((await childApi(req("PUT", {}), deps)).status).toBe(405);
    const bare = new Request("https://lianki.com/api/token/child", { method: "GET" });
    expect((await childApi(bare, deps)).status).toBe(401);
    expect((await childApi(req("GET", undefined, "lk_" + "0".repeat(64)), deps)).status).toBe(401);
    const bad = new Request("https://lianki.com/api/token/child", {
      method: "POST",
      headers: { authorization: `Bearer ${parent}`, "content-type": "application/json" },
      body: "not json",
    });
    expect((await childApi(bad, deps)).status).toBe(400);
    expect((await childApi(req("DELETE", { id: "f".repeat(64) }), deps)).status).toBe(404);
    expect((await childApi(req("DELETE", { id: "nope" }), deps)).status).toBe(404);
    deps.siteOwner = async () => {
      throw new Error("d1");
    };
    expect((await childApi(req("GET"), deps)).status).toBe(403);
  });

  test("an expired parent cannot mint; one ending within minutes cannot either", async () => {
    db.raw()
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(now + 2 * MIN).toISOString(), parentId);
    expect((await mint({ name: "子1" })).status).toBe(400);
    db.raw()
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(now - MIN).toISOString(), parentId);
    expect((await mint({ name: "子1" })).status).toBe(401);
  });

  test("a full name over the token limit and a bad ttl are refused", async () => {
    const long = await mintParent(["chat:read", MINT_CHILD], 7, "x".repeat(35));
    expect((await mint({ name: "abcdefgh" }, long.token)).status).toBe(400);
    expect((await mint({ name: "子1", ttlMinutes: "2h" })).status).toBe(400);
    expect((await mint({ name: "子1", ttlMinutes: 1 })).status).toBe(400);
    expect((await mint({ name: "子1", scopes: [] })).status).toBe(400);
  });
});

describe("revocation", () => {
  test("revoking the parent deletes its children, closes their sockets and logs each", async () => {
    const a = await mint({ name: "子1" });
    const b = await mint({ name: "子2" });
    const api: TokenApiDeps = {
      who: async () => owner,
      db: D,
      revoked: async (ids) => {
        revoked.push(...ids);
      },
      now: () => now,
    };
    const r = await tokenApi(
      new Request("https://lianki.com/api/token", {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: "https://lianki.com" },
        body: JSON.stringify({ id: parentId }),
      }),
      api,
    );
    expect(r.status).toBe(200);
    expect(revoked.sort()).toEqual([parentId, a.body.id, b.body.id].sort() as string[]);
    for (const t of [a, b])
      expect((await checkToken(D(), t.body.token, "chat:read", now)).ok).toBe(false);
    const kinds = audits().map((x) => x.kind);
    expect(kinds.filter((k) => k === "api-token.child-revoke")).toHaveLength(2);
    expect(kinds).toContain("api-token.revoke");
  });

  test("an expired parent ends its children at once (one check path)", async () => {
    const a = await mint({ name: "子1", ttlMinutes: 60 });
    expect((await checkToken(D(), a.body.token, "chat:read", now)).ok).toBe(true);
    db.raw()
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(now + 10 * MIN).toISOString(), parentId);
    const later = now + 11 * MIN;
    expect(await checkToken(D(), a.body.token, "chat:read", later)).toMatchObject({
      ok: false,
      reason: "unknown",
    });
    expect(await describeToken(D(), a.body.token, later)).toBeNull();
  });

  test("taking token:mint-child off the parent ends its children; the parent may revoke one", async () => {
    const a = await mint({ name: "子1" });
    const b = await mint({ name: "子2" });
    const del = await childApi(req("DELETE", { id: a.body.id }), deps);
    expect(del.status).toBe(200);
    expect(revoked).toEqual([a.body.id as string]);
    expect((await checkToken(D(), a.body.token, "chat:read", now)).ok).toBe(false);
    const sdeps: TokenApiDeps = {
      who: async () => owner,
      db: D,
      siteOwner: async () => true,
      childTokens: async () => true,
      revoked: async (ids) => {
        revoked.push(...ids);
      },
      now: () => now,
    };
    const off = await tokenScopeApi(
      new Request("https://lianki.com/api/token/scopes", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          origin: "https://lianki.com",
          host: "lianki.com",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ id: parentId, scope: MINT_CHILD }),
      }),
      sdeps,
    );
    expect(off.status).toBe(200);
    expect(revoked).toContain(b.body.id as string);
    expect((await checkToken(D(), b.body.token, "chat:read", now)).ok).toBe(false);
    // The parent itself keeps its chat permissions.
    expect((await checkToken(D(), parent, "chat:write", now)).ok).toBe(true);
  });
});

describe("the flag", () => {
  test("is positively named, default off", () => {
    expect(FLAGS["tokens.child"].default).toBe(false);
  });

  test("off: the route is a 404 and every child is unknown, as if absent", async () => {
    const a = await mint({ name: "子1" });
    flag(false);
    deps.enabled = async () => false;
    expect((await childApi(req("POST", { name: "子2" }), deps)).status).toBe(404);
    expect((await childApi(req("GET"), deps)).status).toBe(404);
    expect(await checkToken(D(), a.body.token, "chat:read", now)).toMatchObject({
      ok: false,
      reason: "unknown",
    });
    // No row at all reads as the default, off.
    db.raw().exec("DELETE FROM feature_flags WHERE key = 'tokens.child'");
    expect((await checkToken(D(), a.body.token, "chat:read", now)).ok).toBe(false);
    flag(true);
    expect((await checkToken(D(), a.body.token, "chat:read", now)).ok).toBe(true);
  });

  test("off: the token page neither offers nor accepts token:mint-child", async () => {
    const api: TokenApiDeps = {
      who: async () => owner,
      db: D,
      siteOwner: async () => true,
      childTokens: async () => false,
      revoked: async () => {},
      now: () => now,
    };
    const g = (await (await tokenApi(new Request("https://lianki.com/api/token"), api)).json()) as {
      scopes: { id: string }[];
      childTokens?: boolean;
    };
    expect(g.scopes.map((s) => s.id)).not.toContain(MINT_CHILD);
    expect(g.childTokens).toBeUndefined();
    const plain = await mintParent(["chat:read"], 7, "codex");
    const on = await tokenScopeApi(
      new Request("https://lianki.com/api/token/scopes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://lianki.com",
          host: "lianki.com",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ id: plain.id, scope: MINT_CHILD }),
      }),
      api,
    );
    expect(on.status).toBe(400);
  });
});

describe("audit", () => {
  test("a mint row names the child, its scopes, expiry and parent, never the secret", async () => {
    const a = await mint({ name: "子1", ttlMinutes: 30 });
    const row = audits().find((x) => x.kind === "api-token.child-mint")!;
    expect(row.actor).toBe("u1");
    expect(row.subject).toBe((a.body.id as string).slice(0, 16));
    expect(row.detail).toContain("claude·子1");
    expect(row.detail).toContain("[chat:read chat:write]");
    expect(row.detail).toContain(new Date(now + 30 * MIN).toISOString());
    expect(row.detail).toContain(parentId.slice(0, 16));
    expect(JSON.stringify(audits())).not.toContain(a.body.token as string);
  });

  test("scopes: a child's permissions are intersected with its parent's at every use", async () => {
    const a = await mint({ name: "子1", scopes: ["chat:read", "chat:ask"] });
    db.raw()
      .prepare("UPDATE api_tokens SET scopes = ? WHERE token_hash = ?")
      .run(JSON.stringify(["chat:read", MINT_CHILD]), parentId);
    expect((await checkToken(D(), a.body.token, "chat:ask", now)).ok).toBe(false);
    expect((await checkToken(D(), a.body.token, "chat:read", now)).ok).toBe(true);
  });
});

describe("labels", () => {
  test("a child's name shows under its lane's name; any other name is unchanged", () => {
    expect(childShownName("claude·子1")).toBe("小克·子1");
    expect(childShownName("codex·reviewer")).toBe("coco·reviewer");
    expect(childShownName("helper·x")).toBe("helper·x");
    expect(childShownName("claude")).toBe("claude");
    expect(childLane("claude·子1")).toEqual({ parent: "claude", lane: "claude", sub: "子1" });
    expect(childLane("·x")).toBeNull();
    expect(childIndex("子1")).toBe("1");
    expect(childIndex("reviewer")).toMatch(/^[1-9]$/);
  });

  test("the drawn child mark and the name tag", () => {
    const svg = renderToStaticMarkup(childAvatar("claude", "1")!);
    expect(svg).toContain('data-testid="debug-chat-child-mark"');
    expect(svg).toContain('data-index="1"');
    expect(svg).toContain("oklch(");
    expect(renderToStaticMarkup(childAvatar("codex", "12")!)).toContain(">12<");
    const tag = renderToStaticMarkup(
      createElement(LineTag, {
        m: { via: "token", tokenLane: "claude·子1", label: "小克·子1" },
      }),
    );
    expect(tag).toContain("小克·子1");
    expect(tag).toContain('data-parent="小克"');
    const plain = renderToStaticMarkup(
      createElement(LineTag, { m: { via: "token", tokenLane: "helper" } }),
    );
    expect(plain).toContain("helper");
    expect(plain).not.toContain("data-parent");
  });

  test("a child line's avatar is its lane's mark with an index, named 「小克·子1」", () => {
    const m = {
      id: "x",
      from: "agent",
      via: "token",
      tokenLane: "claude·子1",
      label: "小克·子1",
      text: "【claude·子1】hi",
      at: 1,
    } as ChatMessage;
    const seen: string[] = [];
    const a = lineAvatar(m, {
      childAvatar: (lane, index) => {
        seen.push(`${lane}:${index}`);
        return "child";
      },
      tokenAvatar: () => "auto",
    });
    expect(a.name).toBe("小克·子1");
    expect(a.src).toBe("child");
    expect(seen).toEqual(["claude:1"]);
  });
});
