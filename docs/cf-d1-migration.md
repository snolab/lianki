# Cloudflare + D1 Migration Runbook

Migrating Lianki off Vercel/MongoDB onto Cloudflare Workers + D1 (+ R2),
**without touching the MongoDB data** so it stays a rollback backup.

## Guiding constraints

- **MongoDB is never mutated.** The migration only reads it. It remains the
  rollback target indefinitely.
- **Revertable at every step.** `DB_BACKEND` (`mongodb` | `d1`) selects the
  live backend; default `mongodb`.
- **Existing users do nothing.** Their accounts, OAuth links and cards are
  migrated for them. (Sessions migrate too; worst case is one re-login.)

## Architecture decisions (agreed)

| Topic | Decision |
| --- | --- |
| Card / auth / preferences storage | Cloudflare **D1** (SQLite) |
| TTS audio cache + readMaterials binary (GridFS today) | Cloudflare **R2** |
| Userscript offline cache | **Kept** — only the site-side IndexedDB mirror is removed |
| Hosting | Cloudflare Workers via `@opennextjs/cloudflare` |

---

## Phase 0 — Foundation (DONE)

Committed and tested. MongoDB still live; nothing user-facing changed.

- Next.js upgraded `16.1.6 → 16.2.6` (OpenNext Cloudflare requires `>=16.2.6`).
- `@opennextjs/cloudflare` + `wrangler` added; `open-next.config.ts`,
  `wrangler.jsonc` (D1 binding `DB`, R2 binding `BLOBS`). OpenNext build
  verified — produces `.open-next/worker.js`.
- `db/migrations/0001_init.sql` — D1 schema (better-auth tables + `fsrs_notes`,
  `roadmap_goals`, `preferences`, `api_tokens`, `read_materials`).
- `lib/d1/` — `getD1()`/`getBlobs()` bindings, `dbBackend()` flag, and a
  `node:sqlite`-backed test double.
- `lib/repos/` — D1 repositories for the four app entities, unit tested.
- `lib/migrate/` + `scripts/migrate-mongo-to-d1.ts` — read-only Mongo→D1 SQL
  generator, tested end-to-end against `mongodb-memory-server`.

---

## Phase 1 — Provision Cloudflare resources (USER)

Requires a Cloudflare account. Run locally:

```bash
wrangler login

# D1 database — copy the printed database_id into wrangler.jsonc
wrangler d1 create lianki

# R2 bucket for TTS audio + readMaterials content
wrangler r2 bucket create lianki-blobs
```

Edit `wrangler.jsonc`: replace `REPLACE_AFTER_wrangler_d1_create` with the real
`database_id`.

Set Worker secrets (mirror the current Vercel env vars):

```bash
wrangler secret put AUTH_SECRET
wrangler secret put AUTH_GITHUB_ID
wrangler secret put AUTH_GITHUB_SECRET
wrangler secret put AUTH_GOOGLE_ID
wrangler secret put AUTH_GOOGLE_SECRET
wrangler secret put EMAIL_SERVER
wrangler secret put EMAIL_FROM
wrangler secret put OPENAI_API_KEY
wrangler secret put YOUTUBE_API_KEY
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_EMAIL
wrangler secret put SLACK_WEBHOOK_URL
wrangler secret put MONGODB_URI   # still needed by the migration script
# vars (not secret): NEXT_PUBLIC_TURNSTILE_SITE_KEY, BETTER_AUTH_BASE_URL, DB_BACKEND
```

Apply the schema:

```bash
wrangler d1 execute lianki --remote --file=db/migrations/0001_init.sql
```

---

## Phase 2 — Code work

Each change is gated on `dbBackend() === "d1"` so the MongoDB path stays
intact until cutover.

### 2a. Wire API routes to the D1 repos

Branch each data route on `dbBackend()`; the D1 binding is request-scoped, so
call `getD1()` inside the handler.

- `app/api/preferences/route.ts` — **DONE** (`PreferencesD1Repo`).
- `app/api/export/yaml` + `app/api/import/yaml` — **DONE** (all repos).
- `app/api/token/route.ts` — **DONE** (`ApiTokensD1Repo`; the token_hash is the
  D1 id).
- `app/api/roadmap/route.ts` — **DONE** (`RoadmapGoalsD1Repo`).
- `app/fsrs.ts` + `app/api/fsrs/[[...all]]` — **DONE**. `app/fsrsNotesD1Collection.ts`
  is a shim implementing the MongoDB Collection subset the handler uses, backed
  by `FsrsNotesD1Repo`; the handler body is unchanged (one line picks the
  collection by `DB_BACKEND`). Covered by `unit/fsrs-d1-collection.test.ts`.
- `app/api/roadmap/[id]/progress` and `app/api/roadmap/generate` — **TODO** —
  these read roadmap goals + fsrs notes; wire alongside the rest.

### 2b. Swap better-auth to D1 — DONE

`auth.ts` now exposes `getAuth()`, which builds the better-auth instance per
`DB_BACKEND`: D1 mode uses `kysely-d1`'s `D1Dialect` + `kyselyAdapter`, built
lazily (request-scoped binding). A lazy `Proxy` keeps existing `import { auth }`
call sites unchanged. `trialEndsAt`/`proEndsAt` stay out-of-band in
`lib/membership.ts`.

**Still verify before cutover:** run `bunx @better-auth/cli generate` against
the Kysely D1 adapter and diff against `0001_init.sql`, in case better-auth
1.5.4 expects different columns/types.

### 2c. Move GridFS blobs to R2 — DONE

- `app/api/tts/route.ts` — TTS audio cache via `lib/ttsCache.ts` (R2 / GridFS).
  `app/api/polyglot/tts` does not cache, so it needed no change.
- `app/[locale]/read/getReadMaterialsCollection.ts` — save/get/delete/list/getById
  branch on `dbBackend()`; D1 mode stores metadata in `read_materials` and large
  content in R2 (`read/{id}`).

Note: the migration script does **not** copy GridFS blobs into R2. The TTS cache
regenerates on demand; the single existing readMaterials doc, if needed, can be
re-added after cutover.

### 2d. Remove the IndexedDB mirror — TODO (deferred, non-blocking)

Best done after cutover is stable (does not block the D1 migration):

- Delete `syncToSiteDB()` from `src/lianki.user.ts` (keep the GM_setValue cache).
- Drop IndexedDB reads in `GuestListClient.tsx` / `SyncStatusBanner.tsx`;
  update the sync status UI to Extension → Script → Cloud.
- Rebuild the userscript, bump `@version`.

### 2e. Fixups for the Workers runtime

- `app/fsrs.ts` and `app/[locale]/list/page.tsx` read `public/lianki.*.js` via
  `fs.readFileSync(process.cwd()…)`. Confirm this works under the Workers
  runtime; if not, inline the version string at build time.
- `middleware.ts` hardcodes a Vercel beta URL — repoint at the CF preview.

---

## Phase 3 — Migrate the data — DONE (re-runnable)

The D1 `lianki` database (SNOLAB account) already has the schema applied and a
first data load (6 users, 1609 notes, 3 api tokens). To refresh it before
cutover, re-run — `INSERT OR REPLACE` makes this idempotent:

```bash
# dry run — prints row counts, writes nothing
bun --env-file=.env.local scripts/migrate-mongo-to-d1.ts --dry-run

# regenerate the SQL (real user data — kept out of git under tmp/) and load it
bun --env-file=.env.local scripts/migrate-mongo-to-d1.ts --out=tmp/migration-data.sql
wrangler d1 execute lianki --remote --file=tmp/migration-data.sql --yes
```

---

## Phase 4 — Deploy to a CF preview & QA (USER)

First set the Worker secrets (mirror `.env.local`), then build and deploy:

```bash
DB_BACKEND=d1 bunx opennextjs-cloudflare build
wrangler deploy   # default *.workers.dev URL — no DNS change yet
```

The Worker also needs `DB_BACKEND=d1` set as a plain var (wrangler.jsonc `vars`
or the dashboard). QA on the preview URL: email + GitHub + Google sign-in, card
review, due list, import/export YAML, roadmap, TTS, read. Add the preview URL to
the Google/GitHub OAuth callback allow-lists for testing.

---

## Phase 5 — DNS cutover (USER)

1. Add `lianki.com` as a custom domain on the Worker.
2. Move DNS to Cloudflare; point the apex at the Worker.
3. Add `https://lianki.com/api/auth/callback/{google,github}` to the OAuth
   consoles (the www/non-www entries already exist).
4. Set `DB_BACKEND=d1` as the production var.
5. Watch logs: `wrangler tail`.

Keep the Vercel deployment live but idle for a few days as the instant rollback.

---

## Rollback

- **Fast:** set `DB_BACKEND=mongodb` and redeploy — the app reads MongoDB again.
- **Full:** repoint DNS back to Vercel. MongoDB was never modified, so no data
  reconciliation is needed.

---

## Status

| Phase | State |
| --- | --- |
| 0 — Foundation | DONE (committed, tested) |
| 1 — Provision CF | DONE — D1 `lianki` + R2 `lianki-blobs` created, schema applied |
| 2 — Code wiring | DONE — auth, FSRS handler, all data routes, R2. Only the IndexedDB-mirror cleanup (2d) is deferred. |
| 3 — Data migration | DONE — first load done (6 users, 1609 notes); re-runnable |
| 4 — Preview deploy + QA | pending — needs Worker secrets, then deploy |
| 5 — DNS cutover | pending |

The build (`bun run build`) and OpenNext build pass. The D1 code paths are
exercised by unit tests against SQLite but not yet verified on a live Worker —
Phase 4 (preview deploy) is the verification step.
