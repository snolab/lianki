import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export type LiankiEnv = {
  DB: D1Database;
  BLOBS: R2Bucket;
};

/** D1 binding from the Cloudflare request context. Only valid inside a request. */
export function getD1(): D1Database {
  const { env } = getCloudflareContext();
  return (env as unknown as LiankiEnv).DB;
}

/** R2 bucket binding from the Cloudflare request context. */
export function getBlobs(): R2Bucket {
  const { env } = getCloudflareContext();
  return (env as unknown as LiankiEnv).BLOBS;
}

/** Selected DB backend. `d1` once cut over; defaults to `mongodb` for revertability. */
export function dbBackend(): "mongodb" | "d1" {
  return process.env.DB_BACKEND === "d1" ? "d1" : "mongodb";
}
