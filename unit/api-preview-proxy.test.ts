import { describe, expect, it } from "bun:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  dataGateway,
  blobGateway,
  isPreview,
  type CoreBinding,
  type GatewayEnv,
} from "../lib/preview/gateway";
import { assertDataSql, coreQuery, coreBlob, sandbox, type CoreEnv } from "../lib/preview/core";
import { previewProxy } from "../lib/preview/proxy";
import { createTestD1 } from "../lib/d1/testDb";

function fixture() {
  const production = createTestD1(
    "CREATE TABLE cards (id TEXT PRIMARY KEY, value TEXT); INSERT INTO cards VALUES ('real', 'untouched');",
  );
  const db = createTestD1("CREATE TABLE cards (id TEXT PRIMARY KEY, value TEXT);");
  const objects = new Map<string, { bytes: ArrayBuffer; options: any }>();
  const blobs = {
    async get(key: string) {
      const v = objects.get(key);
      return v
        ? {
            key,
            size: v.bytes.byteLength,
            etag: "tag",
            httpEtag: '"tag"',
            uploaded: new Date(0),
            ...v.options,
            arrayBuffer: async () => v.bytes,
          }
        : null;
    },
    async put(key: string, bytes: ArrayBuffer, options: any) {
      objects.set(key, { bytes, options });
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const coreEnv: CoreEnv = {
    CORE_TENANT: "agy",
    PREVIEW_DB: db as unknown as D1Database,
    PREVIEW_BLOBS: blobs,
  };
  let forwarded: Request | undefined;
  const core: CoreBinding = {
    query: (tenant, statements, batch) => coreQuery(coreEnv, tenant, statements, batch),
    blob: (tenant, op, key, bytes, options) => coreBlob(coreEnv, tenant, op, key, bytes, options),
    async proxy(tenant, req) {
      sandbox(coreEnv, tenant);
      forwarded = req;
      return new Response(await req.text(), {
        status: 201,
        headers: {
          "set-cookie": "__Host-preview=abc; Secure; Path=/",
          location: "/api/preferences?done=1",
        },
      });
    },
  };
  const env: GatewayEnv = {
    PREVIEW_MODE: "1",
    PREVIEW_TENANT: "agy",
    PREVIEW_ORIGIN: "https://agy.lianki.pages.dev",
    CORE: core,
    DB: production as unknown as D1Database,
  };
  return { env, coreEnv, production, db, objects, blobs, forwarded: () => forwarded };
}

describe("same-origin preview gateway", () => {
  it("writes and reads only the Core sandbox, even with an accidental local production binding", async () => {
    const { env, production } = fixture();
    const db = dataGateway(env);
    await db.prepare("INSERT INTO cards VALUES (?, ?)").bind("real", "preview").run();
    expect<unknown>(
      await db.prepare("SELECT value FROM cards WHERE id = ?").bind("real").first("value"),
    ).toBe("preview");
    expect<unknown>(
      await production.prepare("SELECT value FROM cards WHERE id = ?").bind("real").first("value"),
    ).toBe("untouched");
    expect<unknown>(
      await db.prepare("SELECT * FROM cards WHERE id = 'missing'").first(),
    ).toBeNull();
    await expect(db.prepare("SELECT * FROM cards").first("missing")).rejects.toThrow(
      "Unknown column",
    );
    expect<unknown>(await db.prepare("SELECT * FROM cards").first()).toEqual({
      id: "real",
      value: "preview",
    });
    expect<unknown>(await db.prepare("SELECT id FROM cards").raw()).toEqual([["real"]]);
    expect<unknown>(await db.prepare("SELECT id FROM cards").raw({ columnNames: true })).toEqual([
      ["id"],
      ["real"],
    ]);
    expect<unknown>(
      await db.prepare("SELECT * FROM cards WHERE 0").raw({ columnNames: true }),
    ).toEqual([]);
    await db.batch([db.prepare("UPDATE cards SET value = ?").bind("batch")]);
    expect<unknown>(await db.prepare("SELECT value FROM cards").first("value")).toBe("batch");
    expect(() => db.batch([{} as never])).toThrow("Foreign statement");
    expect(() => db.exec("DROP TABLE cards")).toThrow("schema");
    expect(() => db.dump()).toThrow("dump");
    expect(() => db.withSession()).toThrow("sessions");
  });

  it("returns production bindings unchanged and fails closed without a Core/tenant", () => {
    const { env, blobs } = fixture();
    expect(dataGateway({ DB: env.DB })).toBe(env.DB!);
    expect(blobGateway({ DB: env.DB, BLOBS: blobs })).toBe(blobs);
    expect(() => blobGateway({ DB: env.DB })).toThrow("Missing BLOBS");
    for (const bad of [{}, { CORE: env.CORE }, { CORE: env.CORE, PREVIEW_TENANT: "../prod" }])
      expect(() => dataGateway(bad)).toThrow("Preview requires");
    expect(isPreview({ CORE: env.CORE })).toBe(true);
  });

  it("refuses foreign tenants, absent sandbox resources, migration SQL and multi-statements", async () => {
    const { coreEnv, db } = fixture();
    for (const env of [
      {},
      { ...coreEnv, PREVIEW_DB: undefined },
      { ...coreEnv, PREVIEW_BLOBS: undefined },
    ])
      expect(() => sandbox(env, "agy")).toThrow("sandbox");
    expect(() => sandbox(coreEnv, "production")).toThrow("tenant");
    for (const sql of [
      "DROP TABLE cards",
      "PRAGMA writable_schema=1",
      "SELECT 1; DELETE FROM cards",
      "WITH x AS (SELECT 1) DELETE FROM sqlite_master",
      "SELECT load_extension(?)",
      "ATTACH DATABASE 'x' AS x",
      'UPDATE "d1_migrations" SET name = ?',
    ])
      expect(() => assertDataSql(sql)).toThrow("data-only");
    for (const sql of [
      "-- comment\nSELECT ';drop table'",
      "/*x*/ WITH x AS (SELECT 1) SELECT * FROM x;",
      'SELECT "value" FROM [cards]',
      "REPLACE INTO cards VALUES (?, ?)",
    ])
      expect(() => assertDataSql(sql)).not.toThrow();
    await expect(
      coreQuery(
        coreEnv,
        "agy",
        [
          { sql: "INSERT INTO cards VALUES ('a', 'a')", params: [] },
          { sql: "DROP TABLE cards", params: [] },
        ],
        true,
      ),
    ).rejects.toThrow();
    expect<unknown>(await db.prepare("SELECT count(*) AS n FROM cards").first("n")).toBe(0);
    await expect(coreBlob(coreEnv, "agy", "put", "x")).rejects.toThrow("Missing blob");
    await expect(coreBlob(coreEnv, "agy", "invalid" as never, "x")).rejects.toThrow("Unknown blob");
  });

  it("forwards data/auth unchanged, overwrites tenant spoofing, and runs branch business routes locally", async () => {
    const f = fixture();
    const url = "https://agy.lianki.pages.dev/api/preferences?x=1";
    const req = new Request(url, {
      method: "POST",
      body: '{"a":1}',
      headers: {
        cookie: "preview=session",
        authorization: "Bearer preview",
        "x-lianki-preview-tenant": "production",
      },
    });
    const res = await previewProxy(req, f.env)!;
    expect(res.status).toBe(201);
    expect<unknown>(await res.text()).toBe('{"a":1}');
    expect(res.headers.get("location")).toBe("/api/preferences?done=1");
    expect(res.headers.get("set-cookie")).toContain("Secure");
    expect(f.forwarded()!.url).toBe(url);
    expect(f.forwarded()!.headers.get("cookie")).toBe("preview=session");
    expect(f.forwarded()!.headers.get("authorization")).toBe("Bearer preview");
    expect(f.forwarded()!.headers.get("x-lianki-preview-tenant")).toBe("agy");
    for (const path of [
      "/api/fsrs/review",
      "/api/words/tts",
      "/api/roadmap/generate",
      "/api/preferences-evil",
      "/words",
    ])
      expect(previewProxy(new Request(`https://agy.lianki.pages.dev${path}`), f.env)).toBeNull();
    f.env.PREVIEW_LOCAL_ROUTES = "/api/preferences,/api/auth";
    expect(previewProxy(new Request(url), f.env)).toBeNull();
    expect<unknown>(
      await previewProxy(new Request("https://agy.lianki.pages.dev/api/auth/get-session"), f.env),
    ).toBeInstanceOf(Response);
    expect(previewProxy(req, { DB: f.env.DB })).toBeNull();
    expect(
      (await previewProxy(new Request("https://evil.test/api/preferences"), f.env))!.status,
    ).toBe(403);
    expect(
      (await previewProxy(new Request(url), { ...f.env, PREVIEW_ORIGIN: undefined }))!.status,
    ).toBe(403);
  });

  it("isolates R2 assets and transports binary bodies, text and metadata", async () => {
    const f = fixture();
    const blobs = blobGateway(f.env);
    expect<unknown>(await blobs.get("missing")).toBeNull();
    await blobs.put("read/1", "hello", {
      httpMetadata: { contentType: "text/plain", cacheExpiry: new Date(0) },
      customMetadata: { user: "preview" },
    });
    const obj = (await blobs.get("read/1"))!;
    expect<unknown>(await obj.text()).toBe("hello");
    expect(obj.customMetadata).toEqual({ user: "preview" });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("expires")).toContain("1970");
    await blobs.put("binary", new Uint8Array([0, 255]));
    expect(new Uint8Array(await (await blobs.get("binary"))!.arrayBuffer())).toEqual(
      new Uint8Array([0, 255]),
    );
    await blobs.put("json", '{"ok":true}');
    expect<unknown>(await (await blobs.get("json"))!.json()).toEqual({ ok: true });
    expect((await (await blobs.get("json"))!.blob()).size).toBe(11);
    (await blobs.get("json"))!.writeHttpMetadata(new Headers());
    await blobs.delete(["binary", "read/1"]);
    await blobs.delete("json");
    expect(f.objects.size).toBe(0);
  });

  it("keeps average in-process adapter overhead under 1ms (not a deployed RPC latency claim)", async () => {
    const { env } = fixture();
    env.CORE = { ...env.CORE!, query: async () => [{ results: [{ n: 1 }] }] };
    const db = dataGateway(env);
    for (let i = 0; i < 100; i++) await db.prepare("SELECT 1").first();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) await db.prepare("SELECT 1").first();
    expect((performance.now() - start) / 1000).toBeLessThan(1);
  });
});

it("requires live production MyBox authorization for every preview API and closes credential login", async () => {
  const { previewHandler } = await import("../lib/preview/proxy");
  const f = fixture();
  const base = "https://agy.lianki.pages.dev";
  let checks = 0;
  let seen: Request | undefined;
  const env = {
    ...f.env,
    LIANKI_BOX_CLIENT_ID: "client",
    CORE_AUTH: {
      async authorize(req: Request) {
        checks++;
        seen = req;
        return new Response(null, {
          status: req.headers.get("authorization") === "Bearer lkb_allowed" ? 204 : 403,
        });
      },
    },
  };
  const next = async (req: Request) =>
    Response.json({
      local: true,
      cookie: req.headers.get("cookie"),
      identity: req.headers.get("x-lk-box-identity"),
    });
  const request = (path: string, headers?: HeadersInit) =>
    new Request(`${base}${path}`, { headers });
  expect((await previewHandler(request("/api/fsrs/review"), env, next)).status).toBe(403);
  expect((await previewHandler(request("/api/auth/sign-in/email"), env, next)).status).toBe(403);
  expect(
    (await previewHandler(request("/api/fsrs/review"), { ...env, CORE_AUTH: undefined }, next))
      .status,
  ).toBe(403);
  expect(
    (
      await previewHandler(
        request("/api/fsrs/review"),
        { ...env, LIANKI_BOX_CLIENT_ID: undefined },
        next,
      )
    ).status,
  ).toBe(403);
  expect(
    (await previewHandler(request("/api/fsrs/review"), { ...env, PREVIEW_ORIGIN: undefined }, next))
      .status,
  ).toBe(403);
  expect(
    (await previewHandler(new Request("https://evil.test/api/fsrs/review"), env, next)).status,
  ).toBe(403);
  expect((await previewHandler(request("/sign-in"), env, next)).status).toBe(200);
  const headers = {
    authorization: "Bearer lkb_allowed",
    cookie: "better-auth.session_token=production",
    "x-lk-box-identity": "forged",
    "x-lianki-preview-tenant": "prod",
  };
  expect(
    await (await previewHandler(request("/api/fsrs/review", headers), env, next)).json(),
  ).toEqual({ local: true, cookie: null, identity: null });
  expect(seen!.headers.get("origin")).toBe(base);
  expect(seen!.headers.get("cookie")).toBeNull();
  expect(seen!.headers.get("x-lianki-preview-tenant")).toBeNull();
  expect(
    (
      await previewHandler(
        request("/api/fsrs/review", { ...headers, origin: "https://evil.test" }),
        env,
        next,
      )
    ).status,
  ).toBe(403);
  const tokenCookie = { cookie: "__Host-lk_box_at=lkb_abcdefghijklmnop" };
  expect((await previewHandler(request("/api/fsrs/review", tokenCookie), env, next)).status).toBe(
    403,
  );
  expect(seen!.headers.get("authorization")).toBe("Bearer lkb_abcdefghijklmnop");
  expect((await previewHandler(request("/api/box/me", headers), env, next)).status).toBe(204);
  expect((await previewHandler(request("/api/preferences", headers), env, next)).status).toBe(201);
  expect(checks).toBe(5);
  const unavailable = {
    ...env,
    CORE_AUTH: {
      authorize: async () => {
        throw new Error("offline");
      },
    },
  };
  expect(
    (await previewHandler(request("/api/fsrs/review", headers), unavailable, next)).status,
  ).toBe(503);
});

it("permits production data only via scoped MyBox handlers, with branch-local overrides first", async () => {
  const { previewHandler } = await import("../lib/preview/proxy");
  const f = fixture();
  const req = new Request("https://agy.lianki.pages.dev/api/fsrs/review", {
    headers: { authorization: "Bearer lkb_allowed" },
  });
  const env: GatewayEnv = {
    ...f.env,
    LIANKI_BOX_CLIENT_ID: "client",
    PREVIEW_PRODUCTION_ROUTES: "/api/fsrs",
    CORE_AUTH: { authorize: async () => new Response(null, { status: 204 }) },
  };
  const next = async () => new Response("branch");
  expect((await previewHandler(req, env, next)).status).toBe(503);
  env.CORE_AUTH!.proxy = async (r) => new Response(r.headers.get("authorization"));
  expect(await (await previewHandler(req, env, next)).text()).toBe("Bearer lkb_allowed");
  env.PREVIEW_LOCAL_ROUTES = "/api/fsrs";
  expect(await (await previewHandler(req, env, next)).text()).toBe("branch");
});
