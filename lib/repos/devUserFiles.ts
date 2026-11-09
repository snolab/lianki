import type { D1Like } from "@/lib/d1/types";

/**
 * Bytes of files each account keeps in R2 (lianki-blobs), for the owner's
 * /dev/users "Files" column. Three kinds of per-account objects exist:
 *
 * - chat inbox uploads (`inbox/<user id>/…`): `inbox_usage.bytes_stored`, a
 *   counter kept in the same batch as every upload and delete;
 * - an uploaded profile picture: `user_avatar.size`;
 * - long reading texts (`read/<material id>`, over 32 KB): no size is stored,
 *   so the `read/` prefix is listed (1000 objects per call, at most
 *   `maxPages` calls) and each object's size is mapped to its material's owner.
 *   The listing is cached per isolate for `READ_SIZES_TTL_MS`, so a page view
 *   costs no R2 call while the cache is warm.
 *
 * Shared objects (TTS cache, book cache, ledger proofs) belong to no account
 * and are not counted.
 */

/** All file bytes, and the inbox part: the only kind with a per-account cap (INBOX.maxStoredBytes). */
export type FileUsage = { bytes: number; inboxBytes: number };

/** The slice of an R2 bucket the listing uses. */
export type ListBucket = {
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
};

export const READ_PREFIX = "read/";
export const READ_SIZES_TTL_MS = 10 * 60_000;

/** Sizes of `read/` objects keyed by material id; `complete` false when the page cap cut it short. */
export async function listReadBlobSizes(
  bucket: ListBucket,
  maxPages = 20,
): Promise<{ sizes: Map<string, number>; complete: boolean }> {
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await bucket.list({ prefix: READ_PREFIX, cursor, limit: 1000 });
    for (const o of res.objects) sizes.set(o.key.slice(READ_PREFIX.length), o.size);
    if (!res.truncated || !res.cursor) return { sizes, complete: true };
    cursor = res.cursor;
  }
  return { sizes, complete: false };
}

let cache: { at: number; sizes: Map<string, number>; complete: boolean } | null = null;

/** listReadBlobSizes behind a per-isolate cache; an R2 failure counts nothing rather than failing the page. */
export async function cachedReadBlobSizes(
  bucket: () => ListBucket,
  now = Date.now(),
): Promise<{ sizes: Map<string, number>; complete: boolean }> {
  if (cache && now - cache.at < READ_SIZES_TTL_MS) return cache;
  try {
    cache = { at: now, ...(await listReadBlobSizes(bucket())) };
    return cache;
  } catch {
    return { sizes: new Map(), complete: false };
  }
}

/** For tests. */
export function resetReadBlobCache() {
  cache = null;
}

/**
 * Per-account file bytes, keyed by user id. `readSizes` maps a material id to
 * its R2 object size; read_materials.user_id has held both the id and the
 * email, so `emailToId` folds the email-keyed rows onto the account.
 */
export async function fileUsageByUser(
  db: D1Like,
  readSizes: Map<string, number>,
  emailToId: Map<string, string>,
): Promise<Map<string, FileUsage>> {
  const [inbox, avatars, reads] = await Promise.all([
    db
      .prepare("SELECT user_id AS k, bytes_stored AS b FROM inbox_usage")
      .all<{ k: string; b: number }>(),
    db.prepare("SELECT userId AS k, size AS b FROM user_avatar").all<{ k: string; b: number }>(),
    readSizes.size
      ? db
          .prepare("SELECT id, user_id AS k FROM read_materials WHERE r2_key IS NOT NULL")
          .all<{ id: string; k: string }>()
      : Promise.resolve({ results: [] as { id: string; k: string }[] }),
  ]);
  const out = new Map<string, FileUsage>();
  const add = (id: string, b: number, inboxBytes = 0) => {
    const u = out.get(id) ?? { bytes: 0, inboxBytes: 0 };
    u.bytes += b;
    u.inboxBytes += inboxBytes;
    out.set(id, u);
  };
  for (const r of inbox.results) add(r.k, Number(r.b) || 0, Number(r.b) || 0);
  for (const r of avatars.results) add(r.k, Number(r.b) || 0);
  for (const r of reads.results) {
    const size = readSizes.get(r.id);
    if (size) add(emailToId.get(r.k) ?? r.k, size);
  }
  return out;
}

/** Compact size: 0 B, 812 B, 3.4 KB, 12 MB, 1.2 GB (one decimal under 10, none above). */
export function compactBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 || v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${s} ${units[i]}`;
}
