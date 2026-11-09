/**
 * The HTTP side of the editable profile (app/api/profile/**, app/api/avatar/**),
 * as plain functions over their dependencies so the gates are unit-tested
 * (unit/profile-edit.test.ts). Every write is same-origin, for the session's own
 * user: `who` and `update` come from the session, and nothing in a request can
 * name another user.
 */
import { chargeInbox, readUsd, storageUsd, uploadUsd } from "@/lib/inbox/charge";
import { SNIFF_BYTES, sniff } from "@/lib/inbox/sniff";
import { hit, type Limit, type ThrottleDb } from "@/lib/security/throttle";
import { sameOriginJson, sameOriginWrite } from "@/lib/security/same-origin";
import {
  AVATAR_TYPES,
  avatarKey,
  avatarPath,
  isAvatarId,
  isAvatarUser,
  isOwnAvatar,
  newAvatarId,
} from "./avatar";
import { PROFILE } from "./config";
import { cleanName } from "./name";

/** The slice of an R2 bucket used here. */
export type AvatarBucket = {
  put(
    key: string,
    body: Uint8Array,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string): Promise<unknown>;
};

export type ProfileUser = { id: string; image?: string | null };

export type ProfileDeps = {
  /** The session's user, or null for a guest. */
  who: () => Promise<ProfileUser | null>;
  /** Write fields of the session's own user (better-auth's updateUser). */
  update: (fields: { name?: string; image?: string | null }) => Promise<void>;
  db: () => ThrottleDb;
  bucket: () => AvatarBucket;
  now?: () => number;
};

type AvatarRow = { r2Key: string; size: number; previousImage: string | null; updatedMs: number };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/** Clean-up that must not change the answer: a leftover object costs less than a failed save. */
const quiet = (p: Promise<unknown>) => p.catch(() => {});

/** Count one use; the 429 response when over the limit. */
async function limited(d: ProfileDeps, what: string, id: string, limit: Limit, now: number) {
  const r = await hit(d.db(), `profile-${what}:${id}`, limit, now);
  if (r.allowed) return null;
  return json({ error: "rate-limited" }, 429, {
    "retry-after": String(Math.ceil(r.retryAfterMs / 1000)),
  });
}

const rowOf = (db: ThrottleDb, userId: string) =>
  db
    .prepare("SELECT r2Key, size, previousImage, updatedMs FROM user_avatar WHERE userId = ?1")
    .bind(userId)
    .first<AvatarRow>();

/** The storage a replaced or removed avatar used, up to now (log-only, as the inbox). */
async function settle(userId: string, row: AvatarRow, now: number) {
  const ms = Math.max(0, now - row.updatedMs);
  await chargeInbox(userId, {
    kind: "storage",
    what: "avatar",
    usd: storageUsd(row.size, ms),
    bytes: row.size,
    ms,
  });
}

/** POST /api/profile/name — {name}. */
export async function postName(req: Request, d: ProfileDeps): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
  const who = await d.who();
  if (!who) return json({ error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const clean = cleanName(body?.name);
  if (!clean.ok) return json({ error: clean.error, max: PROFILE.nameMaxChars }, 400);
  const over = await limited(d, "name", who.id, PROFILE.nameLimit, (d.now ?? Date.now)());
  if (over) return over;
  await d.update({ name: clean.name });
  return json({ name: clean.name });
}

/** The request's bytes, or null past `max`: a Content-Length is a claim, not a fact. */
async function capped(body: ReadableStream<Uint8Array>, max: number) {
  const chunks: Uint8Array[] = [];
  let got = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > max) {
      await quiet(reader.cancel());
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/** POST /api/profile/avatar — the image's raw bytes, already shrunk by the browser. */
export async function postAvatar(req: Request, d: ProfileDeps): Promise<Response> {
  if (!sameOriginWrite(req)) return json({ error: "forbidden" }, 403);
  const who = await d.who();
  if (!who) return json({ error: "unauthorized" }, 401);
  const now = (d.now ?? Date.now)();
  const over = await limited(d, "avatar", who.id, PROFILE.avatarLimit, now);
  if (over) return over;
  const max = PROFILE.avatarMaxBytes;
  if (Number(req.headers.get("content-length")) > max) return json({ error: "too-big", max }, 413);
  if (!req.body) return json({ error: "bad-type" }, 415);
  const bytes = await capped(req.body, max);
  if (!bytes) return json({ error: "too-big", max }, 413);
  // The type comes from the bytes alone, never the browser's claim or a file name.
  const { type } = sniff(bytes.subarray(0, SNIFF_BYTES));
  if (!AVATAR_TYPES.has(type)) return json({ error: "bad-type" }, 415);

  const id = newAvatarId();
  const key = avatarKey(who.id, id);
  const image = avatarPath(who.id, id);
  const db = d.db();
  const old = await rowOf(db, who.id);
  // The provider's picture is kept once, from the first upload on.
  const previous = old ? old.previousImage : isOwnAvatar(who.image) ? null : (who.image ?? null);
  await d.bucket().put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await db
      .prepare(
        `INSERT INTO user_avatar (userId, r2Key, size, previousImage, updatedMs)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(userId) DO UPDATE SET
           r2Key = ?2, size = ?3, previousImage = ?4, updatedMs = ?5`,
      )
      .bind(who.id, key, bytes.length, previous, now)
      .run();
    await d.update({ image });
  } catch (e) {
    // Put the row back and drop the new object: nothing is left pointing at it.
    const undo = old
      ? db
          .prepare("UPDATE user_avatar SET r2Key = ?2, size = ?3, updatedMs = ?4 WHERE userId = ?1")
          .bind(who.id, old.r2Key, old.size, old.updatedMs)
      : db.prepare("DELETE FROM user_avatar WHERE userId = ?1").bind(who.id);
    await quiet(undo.run());
    await quiet(d.bucket().delete(key));
    throw e;
  }
  if (old) {
    await quiet(d.bucket().delete(old.r2Key));
    await settle(who.id, old, now);
  }
  await chargeInbox(who.id, {
    kind: "upload",
    what: "avatar",
    usd: uploadUsd(),
    bytes: bytes.length,
  });
  return json({ image }, 201);
}

/** DELETE /api/profile/avatar — the upload goes; back to the provider's picture, or to none. */
export async function deleteAvatar(req: Request, d: ProfileDeps): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
  const who = await d.who();
  if (!who) return json({ error: "unauthorized" }, 401);
  const now = (d.now ?? Date.now)();
  const over = await limited(d, "avatar", who.id, PROFILE.avatarLimit, now);
  if (over) return over;
  const db = d.db();
  const row = await rowOf(db, who.id);
  // Only ever undoes an upload: a provider's picture with no upload stays.
  if (!row && !isOwnAvatar(who.image)) return json({ image: who.image ?? null });
  const image = row?.previousImage ?? null;
  await d.update({ image });
  if (row) {
    await db.prepare("DELETE FROM user_avatar WHERE userId = ?1").bind(who.id).run();
    await quiet(d.bucket().delete(row.r2Key));
    await settle(who.id, row, now);
  }
  return json({ image });
}

/**
 * GET /api/avatar/<user>/<id> — no session: a picture is shown to whoever sees
 * its owner (the chat's avatars), and the id is random. Only a type checked at
 * upload is ever sent, under nosniff and a sandbox CSP, so even a bad object
 * could not run as a page.
 */
export async function getAvatar(
  userId: string,
  id: string,
  d: Pick<ProfileDeps, "bucket">,
): Promise<Response> {
  const none = () => json({ error: "Not found" }, 404);
  if (!isAvatarUser(userId) || !isAvatarId(id)) return none();
  const obj = await d.bucket().get(avatarKey(userId, id));
  const type = obj?.httpMetadata?.contentType ?? "";
  if (!obj || !AVATAR_TYPES.has(type)) return none();
  await chargeInbox(userId, { kind: "read", what: "avatar", usd: readUsd(), bytes: obj.size });
  return new Response(obj.body, {
    headers: {
      "content-type": type,
      "content-length": String(obj.size),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "cross-origin",
      // A new upload is a new URL, so this URL never changes; removed, it 404s once the cache goes.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
