# Same-origin branch APIs and the Core gateway

A branch serves `/api/*` on its own origin. `worker.ts` runs the production
sibling guard first, then `lib/preview/proxy.ts` in preview mode. Production
`getD1()` and `getBlobs()` return their original bindings without an RPC hop.
Preview mode is `PREVIEW_MODE=1` or absence of a local DB binding.

## Authentication: MyBox only

A preview sets `LIANKI_BOX_CLIENT_ID`, so existing BoxSignIn/BoxApiBridge and
`/box-callback` perform MyBox's PKCE flow with **lianki.com**. The preview
never accepts passwords, credentials, better-auth sessions or `/api/auth/*`.
No production AUTH_SECRET or OAuth provider secrets belong in a branch.

The exact preview origin must be registered to an approved account on
`/dev/box-clients`, and `box.oauth` must be enabled. Existing MyBox SQL checks
`live_frontend_allow` / `account_permission` on every use; being a valid
`*.lianki.pages.dev` hostname grants nothing. Each binding still names one
account and one exact origin. This reuses MyBox's one-box-per-account rule.
The client uses the existing 15-minute access token and rotating refresh token.

With `PREVIEW_MODE=1`, BoxApiBridge adds its access token to **same-origin**
API calls. The Worker strips cookies, forged identities and tenant headers,
and asks production's binding-only `PreviewAuth` entrypoint to check the live
MyBox token, origin, allowlist, scopes and rate limit on every API request.
Failures answer 403; an unavailable authority answers 503. Credential endpoints
answer 403 even if the caller holds a valid access token. Server-rendered pages
reuse MyBox's existing server session lookup (its existing cache is 30 seconds);
the API gate is uncached. Public assets, OAuth callback and sign-in pages remain
accessible so authorization can start; they grant no API access.

## Persistence and isolation

`lib/preview/gateway.ts` adapts D1 prepare/bind/first/all/run/raw/batch and the
app's R2 get/put/delete subset to the named `PreviewCore` Service Binding.
D1 batch stays one native transaction. Exec, dump and D1 sessions are refused.
R2 bodies are buffered into RPC-safe bytes, so large uploads have buffering
costs; multipart/list/head and conditional/range reads are not implemented.

Each tenant has a **dedicated Core isolate, PREVIEW_DB and PREVIEW_BLOBS**.
Core chooses only these bindings, never DB/BLOBS, including if production
bindings are accidentally present. Missing sandbox resources or a different
tenant fail closed. SQL accepts data statements and rejects DDL, multiple
statements and SQLite/migration control tables; schema migrations belong to
centrally maintained Core deployments, never the branch runtime.

This physical boundary covers existing joins, whole-table writes and user
foreign keys without fragile SQL rewriting. Sandbox datasets must include
synthetic/sanitized users needed by the business routes. No production database
copy or automatic schema migration is performed by this feature.

The owner may explicitly opt routes into **real production data** with
`PREVIEW_PRODUCTION_ROUTES=/api/fsrs,/api/preferences`, preferably a read-only
MyBox binding for exploration. Those requests use production's existing
HTTP handlers through `PreviewAuth.proxy`, with all existing per-account route
and scope checks. Write scope permits real writes, as on MyBox. Raw SQL/R2
capabilities always remain sandbox-only. Arbitrary production SQL access is
never exposed to preview code.

Data routes (preferences, profile, tokens, export, YAML import) default to Core;
other business routes execute in the branch. MyBox's deny-by-default route
allowlist still applies first: e.g. account/token-management routes remain
closed even if listed here. Set `PREVIEW_LOCAL_ROUTES=/api/preferences` for a
branch override. Matching uses path segments, never arbitrary prefix matching.
Local overrides take priority over explicitly selected production routes.
Routing is explicit configuration; no runtime git-diff guessing is performed.

## Configuration and provisioning

`wrangler.preview.jsonc` is the branch Worker template, containing only CORE
and CORE_AUTH bindings, no DB/R2/migrations/cron/PUSH or production secrets.
`wrangler.preview-core.jsonc` is a centrally managed Core sandbox template.
Do not deploy the placeholder database ID or client id.

Before a deployment (which needs approval):

1. Provision a separate D1 and R2 bucket for the tenant, centrally apply the
   compatible schema to that sandbox, and configure PREVIEW_DB/PREVIEW_BLOBS.
2. Register the exact client origin in production MyBox and enable its flag;
   fill LIANKI_BOX_CLIENT_ID in both templates. Use a separate read-only binding
   when production data is selected. Existing one-box-per-account applies.
3. Set PREVIEW_ORIGIN, CORE_ORIGIN and BETTER_AUTH_BASE_URL to the actual
   preview origin. Use a separate Worker origin/custom domain for OpenNext;
   the Pages hostname is an example only. Pages hosting additionally needs its
   own deployment adapter and equivalent bindings; these Worker configs do not
   deploy a Pages project or attach a Worker to Cloudflare's pages.dev domain.
4. CORE targets that tenant's PreviewCore. CORE_AUTH targets production lianki's
   PreviewAuth. The Core sandbox uses LIANKI_BOX_CLIENT_ID too and receives no
   OAuth credential secrets. Public Core fetches return 404, and it has no cron.
5. Build with OpenNext and review/deploy through the approved release flow.
   Production `wrangler.jsonc` deliberately has no self-CORE binding.

There is no public HTTP SQL fallback and no database provisioning during a
branch build. Configuring a binding is not a deployment or account change.

## Validation

- `bun test unit/api-preview-proxy.test.ts`: forwarding, branch priority,
  fail-closed auth, tenant spoofing, production opt-in, sandbox SQL/R2 isolation,
  batch validation and adapter latency.
- `bun scripts/qa/qa-api-preview-proxy.ts`: three real local workerd isolates and
  Service Binding RPC with separate ephemeral D1/R2 stores; verifies the actual
  PreviewCore entrypoint and live MyBox allowlist checks before/after revocation. The OpenNext route body is a fixture, so this is not
  a complete browser OAuth or full application deployment test.
- Existing MyBox suites cover PKCE, credential refusal, allowlists, scopes,
  revocation and identity handling; the Pages-origin test covers live list
  enforcement before and after removal.

The unit benchmark measures **average local adapter overhead <1ms**, not a
Cloudflare latency SLA. Cloudflare documents Service Binding RPC as an internal
API without a public URL ([RPC documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)).
Actual deployed RPC latency, OAuth browser flow on the registered preview
origin, and full OpenNext integration require post-deployment verification.
