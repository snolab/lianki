#!/usr/bin/env bun
/** Local end-to-end workerd test: three isolates, a real Service Binding, D1 and R2.
 * bun scripts/qa/qa-api-preview-proxy.ts
 * No remote bindings, accounts or production data are used.
 */
import assert from "node:assert/strict";
import { boxTokenHash } from "../../lib/box-oauth/gate";
import { createRequire } from "node:module";

// Use Wrangler's installed Miniflare version, including the repo's patch.
const requireWrangler = createRequire(require.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = requireWrangler("miniflare");
const built = await Bun.build({
  entrypoints: ["scripts/qa/fixtures/preview-gateway.worker.ts"],
  target: "browser",
  external: ["cloudflare:workers"],
  plugins: [
    {
      name: "OpenNext route fixture",
      setup(build) {
        build.onResolve({ filter: /\.open-next\/worker\.js$/ }, () => ({
          path: "handler",
          namespace: "route-fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "route-fixture" }, () => ({
          loader: "js",
          contents: `
      export default { async fetch(req, env) {
        await env.DB.prepare("INSERT INTO cards VALUES (?, ?)").bind("core", await req.text()).run();
        return Response.json({ url: req.url, tenant: req.headers.get("x-lianki-preview-tenant"), cookie: req.headers.get("cookie") }, {status: 201, headers: {"set-cookie": "preview_session=isolated; Secure; Path=/"}});
      }};
    `,
        }));
      },
    },
  ],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const script = await built.outputs[0].text();
const token = `lkb_${"a".repeat(32)}`;
const origin = "https://agy.lianki.pages.dev";
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "preview",
        modules: true,
        script,
        compatibilityDate: "2025-05-05",
        bindings: {
          PREVIEW_MODE: "1",
          PREVIEW_TENANT: "agy",
          PREVIEW_ORIGIN: origin,
          LIANKI_BOX_CLIENT_ID: "client",
        },
        serviceBindings: {
          CORE: { name: "core", entrypoint: "PreviewCore" },
          CORE_AUTH: { name: "authority", entrypoint: "PreviewAuth" },
        },
      },
      {
        name: "authority",
        modules: true,
        script,
        compatibilityDate: "2025-05-05",
        bindings: { AUTH_SECRET: "test-secret-".repeat(4) },
        d1Databases: { DB: "production" },
      },
      {
        name: "core",
        modules: true,
        script,
        compatibilityDate: "2025-05-05",
        bindings: { CORE_TENANT: "agy", CORE_ORIGIN: origin },
        d1Databases: { PREVIEW_DB: "sandbox", DB: "production" },
        r2Buckets: { PREVIEW_BLOBS: "sandbox-assets", BLOBS: "production-assets" },
      },
    ],
  }),
);
try {
  const sandbox = await mf.getD1Database("PREVIEW_DB", "core");
  const prod = await mf.getD1Database("DB", "core");
  for (const db of [sandbox, prod])
    await db.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, value TEXT)");
  await prod.prepare("INSERT INTO cards VALUES ('real', 'untouched')").run();
  await prod.exec(
    "CREATE TABLE user (id TEXT, email TEXT); CREATE TABLE account_permission (email TEXT, permission TEXT, revoked_at INTEGER); CREATE TABLE live_frontend_allow (user_id TEXT); CREATE TABLE oauthClient (clientId TEXT, disabled INTEGER); CREATE TABLE box_binding (client_id TEXT, user_id TEXT, origin TEXT, scopes TEXT, revoked_at INTEGER); CREATE TABLE oauthAccessToken (token TEXT, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT, revoked TEXT)",
  );
  await prod.prepare("INSERT INTO user VALUES ('approved', 'approved@test.example')").run();
  await prod.prepare("INSERT INTO oauthClient VALUES ('client', NULL)").run();
  await prod
    .prepare("INSERT INTO box_binding VALUES ('client', 'approved', ?, 'box:read box:write', NULL)")
    .bind(origin)
    .run();
  await prod
    .prepare(
      "INSERT INTO oauthAccessToken VALUES (?, 'client', 'approved', 'box:read box:write', ?, NULL)",
    )
    .bind(await boxTokenHash(token), new Date(Date.now() + 60_000).toISOString())
    .run();
  const preview = await mf.getWorker("preview");
  console.log("workerd: local business RPC");
  assert.equal((await preview.fetch(`${origin}/api/fsrs/review`)).status, 403);
  assert.equal(
    (await preview.fetch(`${origin}/api/auth/sign-in/email`, { method: "POST" })).status,
    403,
  );
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await preview.fetch(`${origin}/api/fsrs/review`, { headers })).status, 403);
  await prod.prepare("INSERT INTO live_frontend_allow VALUES ('approved')").run();
  const local = await preview.fetch(`${origin}/api/fsrs/review`, { headers });
  assert.equal(local.status, 200);
  assert.deepEqual(await local.json(), {
    local: true,
    card: { id: "branch", value: "local-business" },
    bytes: [0, 1, 255],
  });
  console.log("workerd: same-origin proxy");
  const proxied = await preview.fetch(`${origin}/api/preferences?source=same-origin`, {
    method: "POST",
    body: "preview-write",
    headers: { ...headers, cookie: "preview_session=abc", "x-lianki-preview-tenant": "production" },
  });
  assert.equal(proxied.status, 201);
  assert.deepEqual(await proxied.json(), {
    url: `${origin}/api/preferences?source=same-origin`,
    tenant: "agy",
    cookie: null,
  });
  assert.match(proxied.headers.get("set-cookie")!, /preview_session=isolated/);
  assert.equal(
    await sandbox.prepare("SELECT value FROM cards WHERE id='core'").first("value"),
    "preview-write",
  );
  assert.deepEqual((await prod.prepare("SELECT * FROM cards").all()).results, [
    { id: "real", value: "untouched" },
  ]);
  const productionAssets = await mf.getR2Bucket("BLOBS", "core");
  assert.equal(await productionAssets.get("preview-asset"), null);
  const core = (await mf.getBindings("preview")).CORE;
  await assert.rejects(
    async () => await core.query("production", [{ sql: "DELETE FROM cards", params: [] }], false),
  );
  await assert.rejects(
    async () => await core.query("agy", [{ sql: "DROP TABLE cards", params: [] }], false),
  );
  const refused = await core.proxy("agy", new Request("https://evil.test/api/preferences"));
  assert.equal(refused.status, 403);
  await prod.prepare("DELETE FROM live_frontend_allow").run();
  assert.equal((await preview.fetch(`${origin}/api/fsrs/review`, { headers })).status, 403);
  console.log(
    "PASS: real workerd RPC, local business routes, same-origin forwarding, D1/R2 production isolation, live MyBox allowlist/revocation, credential refusal, tenant and DDL refusal",
  );
} finally {
  await mf.dispose();
}
