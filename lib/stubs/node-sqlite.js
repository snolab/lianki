// Build-time stub for `node:sqlite`.
//
// @better-auth/kysely-adapter's entry eagerly imports `node:sqlite` for its
// NodeSqliteDialect. Lianki never uses that dialect — D1 mode uses kysely-d1's
// D1Dialect — and `node:sqlite` is unavailable in the Cloudflare Workers
// runtime. Turbopack aliases `node:sqlite` to this stub (see next.config.mjs).
// The class is never instantiated.
export class DatabaseSync {}
export class StatementSync {}
