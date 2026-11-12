import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { BlobValue, Statement } from "./gateway";

export type CoreEnv = {
  CORE_TENANT?: string;
  CORE_ORIGIN?: string;
  PREVIEW_DB?: D1Database;
  PREVIEW_BLOBS?: R2Bucket;
};
/** Never use env.DB/BLOBS here: they may contain production accounts and assets. */
export function sandbox(env: CoreEnv, tenant: string) {
  if (!env.CORE_TENANT || tenant !== env.CORE_TENANT || !env.PREVIEW_DB || !env.PREVIEW_BLOBS)
    throw new Error("Preview sandbox unavailable or tenant refused");
  return { db: env.PREVIEW_DB, blobs: env.PREVIEW_BLOBS };
}
/** Conservative DML-only contract. Values belong in bind parameters, never SQL literals. */
export function assertDataSql(sql: string): void {
  // Strip quoted literals/identifiers and comments before checking statement structure.
  const code = sql
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (
    !/^(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(code) ||
    /;\s*\S|\b(CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|LOAD_EXTENSION)\b/i.test(
      code,
    ) ||
    /\b(?:sqlite_\w+|d1_migrations)\b/i.test(sql)
  )
    throw new Error("Preview SQL must be data-only; migrations belong to Core");
}
export async function coreQuery(
  env: CoreEnv,
  tenant: string,
  statements: Statement[],
  batch: boolean,
) {
  const { db } = sandbox(env, tenant);
  // Validate the whole batch before executing even its first statement.
  for (const s of statements) assertDataSql(s.sql);
  const prepared = statements.map((s) => db.prepare(s.sql).bind(...s.params));
  return batch ? db.batch(prepared) : Promise.all(prepared.map((s) => s.all()));
}
export async function coreBlob(
  env: CoreEnv,
  tenant: string,
  op: "get" | "put" | "delete",
  key: string,
  value?: ArrayBuffer,
  options?: unknown,
): Promise<BlobValue | null> {
  const { blobs } = sandbox(env, tenant);
  if (op === "delete") {
    await blobs.delete(key);
    return null;
  }
  if (op === "put") {
    if (!value) throw new Error("Missing blob body");
    await blobs.put(key, value, options as never);
    return null;
  }
  if (op !== "get") throw new Error("Unknown blob operation");
  const obj = await blobs.get(key);
  return obj
    ? {
        bytes: await obj.arrayBuffer(),
        key: obj.key,
        size: obj.size,
        etag: obj.etag,
        httpEtag: obj.httpEtag,
        uploaded: obj.uploaded,
        httpMetadata: obj.httpMetadata as BlobValue["httpMetadata"],
        customMetadata: obj.customMetadata,
      }
    : null;
}
