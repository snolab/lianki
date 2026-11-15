import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import {
  checkToken,
  createToken,
  DEFAULT_TOKEN_SCOPES,
  parseScopes,
  type ScopeId,
} from "@/lib/api-tokens";
import { tokenScopeApi } from "@/lib/api-token-scopes";
import { CONFIG } from "@/lib/config";
import { embedView, hostView, type MiniDeps, type MiniWho } from "@/lib/mini-apps/handlers";
import { publishRequest } from "@/lib/mini-apps/publish-auth";
import { getApp } from "@/lib/mini-apps/store";

const NOW = Date.parse("2026-11-15T00:00:00Z");
const owner = { userId: "user", email: "user@example.test" };
const manifest = {
  slug: "counter",
  name: "Counter",
  icon: "🧮",
  version: "1.0.0",
  style: "none",
  permissions: ["chat:write"],
};
let db: TestD1Database,
  deps: MiniDeps,
  session: MiniWho | null,
  sessionReads: number,
  checks: number;
let enabled: boolean, files: Map<string, string>;
beforeEach(() => {
  db = createTestD1(testSchema());
  db.raw().exec(
    "INSERT INTO user (id,email,name,createdAt,updatedAt) VALUES ('dev','dev@example.test','Developer','2026-11-15','2026-11-15'), ('user','user@example.test','User','2026-11-15','2026-11-15')",
  );
  session = { id: "dev", email: "dev@example.test", dev: true };
  sessionReads = 0;
  checks = 0;
  enabled = true;
  files = new Map();
  deps = {
    who: async () => {
      sessionReads++;
      return session;
    },
    on: async () => enabled,
    db: () => db,
    bucket: () => ({
      put: async (k, v) => {
        files.set(k, v);
      },
      get: async (k) => (files.has(k) ? { text: async () => files.get(k)! } : null),
      delete: async () => {},
    }),
    config: async () => ({
      maxBytes: 4096,
      storageBytes: 4096,
      perAccount: 1,
      callsPerMinute: 10,
      cardWaitMs: 1000,
      origin: "https://{id}.apps.example.test",
      scripts: CONFIG["miniApps.scriptOrigins"].default,
      styles: CONFIG["miniApps.styleOrigins"].default,
      fonts: CONFIG["miniApps.fontOrigins"].default,
      prefKeys: CONFIG["miniApps.prefKeys"].default,
    }),
    secret: () => "s".repeat(40),
    now: () => NOW,
  };
});
const makeToken = async (
  scopes: ScopeId[] = ["apps:publish", "chat:write"],
  expires = NOW + 86400000,
) => createToken(db, owner, { name: "publisher", scopes, expiresAt: new Date(expires) }, NOW);
const request = (
  token?: string,
  body: unknown = { manifest, html: "<!doctype html><p>Counter</p>" },
  extra: Record<string, string> = {},
) =>
  new Request("https://lianki.com/api/my/mini-apps", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined
        ? { origin: "https://lianki.com" }
        : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const run = (req: Request) =>
  publishRequest(req, deps, async (token) => {
    checks++;
    return checkToken(db, token, "apps:publish", NOW);
  });

describe("account-bound mini-app publication and opaque chat views", () => {
  it("publishes/replaces for token account without reading ambient dev session or granting capabilities", async () => {
    const { token } = await makeToken();
    expect((await run(request(token))).status).toBe(201);
    expect(sessionReads).toBe(0);
    expect(await getApp(db, "dev", "counter")).toBeNull();
    const app = await getApp(db, "user", "counter");
    expect(app?.ownerId).toBe("user");
    expect(app?.style).toBe("none");
    expect(
      (
        await run(
          request(token, {
            manifest: { ...manifest, ownerId: "dev" },
            html: "<!doctype html><p>new</p>",
          }),
        )
      ).status,
    ).toBe(200);
    expect((await getApp(db, "user", "counter"))?.id).toBe(app?.id);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM mini_app_grant").first<{ n: number }>())?.n,
    ).toBe(0);
  });
  it("requires both independently approved scopes and never broadens defaults", async () => {
    expect(DEFAULT_TOKEN_SCOPES).not.toContain("apps:publish");
    expect(parseScopes(["apps:publish"])).toEqual(["apps:publish"]);
    for (const [scopes, needed] of [
      [["chat:write"], "apps:publish"],
      [["apps:publish"], "chat:write"],
    ] as [ScopeId[], ScopeId][]) {
      const { token, id } = await makeToken(scopes);
      const response = await run(request(token));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "scope",
        needScope: needed,
        requestUrl: `https://lianki.com/my/tokens/scopes?token=${id}&scope=${encodeURIComponent(needed)}`,
      });
    }
    expect(files.size).toBe(0);
  });
  it("ordinary session owner can explicitly approve apps:publish as one additive scope", async () => {
    const { token, id } = await makeToken(["chat:write"]);
    const approve = new Request("https://lianki.com/api/token/scopes", {
      method: "POST",
      headers: {
        origin: "https://lianki.com",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ id, scope: "apps:publish" }),
    });
    const response = await tokenScopeApi(approve, {
      who: async () => owner,
      db: () => db,
      revoked: async () => {},
      now: () => NOW,
      siteOwner: async () => false,
    });
    expect(response.status).toBe(200);
    expect((await checkToken(db, token, "apps:publish", NOW)).ok).toBe(true);
    expect((await run(request(token))).status).toBe(201);
  });
  it("refuses expired, revoked, deleted-account and malformed tokens without session fallback", async () => {
    const expired = await makeToken(undefined, NOW - 1),
      revoked = await makeToken(),
      deleted = await makeToken();
    await db.prepare("DELETE FROM api_tokens WHERE token_hash = ?").bind(revoked.id).run();
    for (const secret of [expired.token, revoked.token, "broken"])
      expect((await run(request(secret))).status).toBe(401);
    await db.prepare("DELETE FROM user WHERE id = 'user'").run();
    expect((await run(request(deleted.token))).status).toBe(401);
    expect(
      (await run(request(undefined, undefined, { authorization: "Basic invalid" }))).status,
    ).toBe(401);
    expect(sessionReads).toBe(0);
    expect(files.size).toBe(0);
  });
  it("preserves session dev/CSRF gates and rejects hostile browser bearer requests", async () => {
    session = { id: "user", email: owner.email, dev: false };
    expect((await run(request())).status).toBe(403);
    session = { id: "dev", email: "dev@example.test", dev: true };
    expect((await run(request())).status).toBe(201);
    expect(
      (await run(request(undefined, undefined, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    const { token } = await makeToken();
    for (const extra of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "content-type": "text/plain" },
      { origin: "null" },
    ] as Record<string, string>[])
      expect((await run(request(token, undefined, extra))).status).toBe(403);
    expect(
      (
        await run(
          request(token, undefined, {
            origin: "https://lianki.com",
            "sec-fetch-site": "same-origin",
          }),
        )
      ).status,
    ).toBe(201);
  });
  it("retains flag, rate, account quota, manifest/body limits and external-source validation", async () => {
    const { token } = await makeToken();
    enabled = false;
    expect((await run(request(token))).status).toBe(404);
    expect(checks).toBe(0);
    enabled = true;
    deps.allow = () => false;
    expect((await run(request(token))).status).toBe(429);
    deps.allow = () => true;
    expect((await run(request(token, "{"))).status).toBe(400);
    expect(
      (await run(request(token, { manifest: { ...manifest, slug: "../bad" }, html: "<p>" })))
        .status,
    ).toBe(400);
    expect((await run(request(token, { manifest, html: "x".repeat(5000) }))).status).toBe(413);
    expect(
      (
        await run(
          request(token, {
            manifest,
            html: "<!doctype html><script src='https://evil.example/x.js'></script>",
          }),
        )
      ).status,
    ).toBe(400);
    expect((await run(request(token, undefined, { "content-length": "999999" }))).status).toBe(413);
    expect((await run(request(token))).status).toBe(201);
    expect(
      (
        await run(
          request(token, {
            manifest: { ...manifest, slug: "second" },
            html: "<!doctype html><p>Second</p>",
          }),
        )
      ).status,
    ).toBe(413);
  });
  it("serves embed only for logged-in app owner with forced opaque srcdoc and existing CSP", async () => {
    const { token } = await makeToken();
    await run(request(token));
    const req = new Request("https://lianki.com/api/my/mini-apps/counter?embed=1", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await embedView(req, "counter", deps)).status).toBe(404);
    session = null;
    expect((await embedView(req, "counter", deps)).status).toBe(404);
    session = { id: "user", email: owner.email, dev: false };
    expect((await hostView("counter", "https://lianki.com", deps))?.frame.mode).toBe("origin");
    const result = await embedView(req, "counter", deps);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    const { view } = await result.json();
    expect(view.frame.mode).toBe("srcdoc");
    expect(view.frame.sandbox).toBe("allow-scripts allow-forms");
    expect(view.frame.srcdoc).toContain("connect-src 'none'");
    expect(view.frame.srcdoc).toContain("https://lianki.com/m/sdk.js");
    expect(view.frame.srcdoc).not.toContain("allow-same-origin");
    expect(view.grants).toEqual({});
    files.clear();
    expect((await embedView(req, "counter", deps)).status).toBe(404);
    expect((await embedView(req, "../bad", deps)).status).toBe(404);
    enabled = false;
    expect((await embedView(req, "counter", deps)).status).toBe(404);
  });
});
