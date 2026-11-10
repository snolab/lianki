# Config store: live values with defaults in code

**Principle (owner, 2026-11-10):** every user-meaningful number, text and icon
may change at any time. Code holds only the **default**; the live value comes
from the DB (hot-editable at `/dev/config`) or env. A new limit, timeout,
threshold or label goes in the registry as a key, not in a bare constant.

| Piece                    | File                                         |
| ------------------------ | -------------------------------------------- |
| Registry (client-safe)   | `lib/config.ts`                              |
| Server read/write        | `lib/config-store.ts`                        |
| Browser read             | `lib/config-client.ts`, `PublicConfig.tsx`   |
| Cache (shared w/ flags)  | `lib/snapshot-cache.ts`                      |
| Tables                   | `db/migrations/0070_config_values.sql`       |
| Editor (admin)           | `/dev/config`, `app/api/dev/config/route.ts` |
| Tests                    | `unit/config.test.ts`, `qa:all --suites=config` |

## Read order

1. **Code default** — `CONFIG[key].default` in `lib/config.ts`.
2. **Global value** — the `config_values` row, if it passes the key's zod
   schema (and min/max). An invalid row, an unknown key's row, no D1, or a
   failed read all give the default: **fail to defaults** (flags, by contrast,
   fail closed).
3. **The user's own value** — only for a key with `userPref: true`, passed to
   `cfg(key, userValue)`; it must validate too, or the global value stands.

Values are cached per isolate for 30 s (`CONFIG_CACHE_MS`, the same
`snapshotCache` as the flags): a change reaches every request within 30 s, no
deploy. The isolate that writes drops its cache at once.

## Reading a value

- **Server:** `await cfg("study.humanReactionMs")` (`lib/config-store.ts`).
- **Browser:** `publicCfg("words.undoMs")` (`lib/config-client.ts`), for keys
  with `audience: "public"` only. The app layout (`app/(app)/layout.tsx`) reads
  the public keys and wraps the app in `<PublicConfig values>`, which hands them
  to `config-client` before any page renders, so the server render and the
  browser agree. Outside the app layout the default is used. Keys with
  `audience: "server"` never leave the server.

## Adding a key

1. Add an entry to `CONFIG` in `lib/config.ts`: `default`, `schema` (zod; for
   whole numbers use the `int({ min, max, … })` helper), `description` (the
   owner's language, shown on /dev/config), `group` (the section), `unit`,
   `audience`, and `money: true` if it moves real money.
2. Replace the constant at its call sites with `cfg(key)` (server) or
   `publicCfg(key)` (browser). Keep a named export for the default only if a
   caller needs a synchronous fallback (`HUMAN_REACTION_MS` in
   `lib/study-days.ts`).
3. `unit/config.test.ts` checks every key's default validates and sits in its
   range; add a test for the new call site.

No migration is needed: a key with no row reads as its default.

## The editor: /dev/config

Admin only (`isAdmin`, `lib/dev-page-permissions.ts`); anyone else gets a
plain 404, page and API. Grouped by `group`; each row shows the key, its
description, whether it reaches browsers, the default and range, a **Changed**
badge (seal red) when the live value differs from the default, a value field
with an optional "why" note, **Save**, **Reset to default** (removes the row),
and its history from `config_log` (old → new, who, when, why; `default` for
no row). A `money` key asks before saving and the API refuses it without
`confirmMoney: true`. Strings: `app/(app)/dev/config/config-admin.content.ts`
(`dev-config`, 16 locales with context lines).

## Tables

`config_values (key PK, value_json, updated_at, updated_by)` and the
append-only `config_log (id, key, old_json, new_json, by, at, note)`. A write is
one batch: the log row (reading the old value in the same transaction) and the
upsert or delete. D1 only — there is no Mongo copy (MongoDB is the frozen
rollback store).

## Migrated so far (first batch, 2026-11-10)

| Key                     | Was                                        | Audience |
| ----------------------- | ------------------------------------------ | -------- |
| `words.undoMs`          | `UNDO_MS` in `lib/words/deferred-delete.ts` | public   |
| `files.undoMs`          | `UNDO_MS` in `lib/import/uploads-client.ts` | public   |
| `read.startWpm`         | `START_WPM` in `lib/read/reader-adapter.ts` | public   |
| `study.humanReactionMs` | `HUMAN_REACTION_MS` in `lib/study-days.ts`  | server   |
| `contact.fieldMax`      | `CONTACT_FIELD_MAX` in `lib/contact.ts`     | server   |

Next (separate PRs): the rest of the magic-number audit list, language packs,
icon packs. Prices, credits and Stripe amounts move only with `money: true`
and their own review.
