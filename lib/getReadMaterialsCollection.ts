import { GridFSBucket, ObjectId } from "mongodb";
import { db } from "@/app/db";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { bookHash } from "@/lib/read/units";

export interface ReadMaterial {
  _id: ObjectId | string;
  userId: string;
  title: string;
  lines: string[];
  contentId?: ObjectId; // GridFS file ID for large content (MongoDB backend)
  r2Key?: string; // R2 object key for large content (D1 backend)
  content?: string; // Direct content for small materials (<32KB)
  /** When it first passed (95% of its running words known); set once. */
  passedAt?: Date;
  /** The book hash of its plain lines (lib/read/units.ts bookHash); D1, set at import or on next open. */
  contentHash?: string;
  /** Where it was imported from, when it can be imported again ("gdoc:<id>"); D1. */
  sourceKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GRIDFS_THRESHOLD = 32 * 1024; // 32KB
const R2_PREFIX = "read/";

export function getReadMaterialsCollection(_userId: string) {
  return db.collection<ReadMaterial>("readMaterials");
}

export function getReadMaterialsBucket() {
  return new GridFSBucket(db, { bucketName: "readMaterialsContent" });
}

export function getTTSVoiceCacheBucket() {
  return new GridFSBucket(db, { bucketName: "ttsVoiceCache" });
}

// ── D1 row mapping ───────────────────────────────────────────────────────────

type ReadMaterialRow = {
  id: string;
  user_id: string;
  title: string;
  lines: string;
  r2_key: string | null;
  content: string | null;
  passed_at?: string | null;
  content_hash?: string | null;
  source_key?: string | null;
  created_at: string;
  updated_at: string;
};

function rowToMaterial(row: ReadMaterialRow): ReadMaterial {
  return {
    _id: row.id,
    userId: row.user_id,
    title: row.title,
    lines: JSON.parse(row.lines || "[]"),
    r2Key: row.r2_key ?? undefined,
    content: row.content ?? undefined,
    passedAt: row.passed_at ? new Date(row.passed_at) : undefined,
    contentHash: row.content_hash ?? undefined,
    sourceKey: row.source_key ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function saveReadMaterial(
  userId: string,
  title: string,
  content: string,
  lines: string[],
  contentHash?: string,
  sourceKey?: string,
): Promise<ReadMaterial> {
  const now = new Date();
  const large = Buffer.byteLength(content, "utf8") >= GRIDFS_THRESHOLD;

  if (dbBackend() === "d1") {
    const id = crypto.randomUUID();
    const r2Key = large ? `${R2_PREFIX}${id}` : undefined;
    if (r2Key) await getBlobs().put(r2Key, content);
    await getD1()
      .prepare(
        `INSERT INTO read_materials
           (id, user_id, title, lines, r2_key, content, content_hash, source_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        title,
        JSON.stringify(lines),
        r2Key ?? null,
        large ? null : content,
        contentHash ?? null,
        sourceKey ?? null,
        now.toISOString(),
        now.toISOString(),
      )
      .run();
    return {
      _id: id,
      userId,
      title,
      lines,
      r2Key,
      content: large ? undefined : content,
      contentHash,
      sourceKey,
      createdAt: now,
      updatedAt: now,
    };
  }

  const collection = getReadMaterialsCollection(userId);
  const doc: Omit<ReadMaterial, "_id"> = { userId, title, lines, createdAt: now, updatedAt: now };
  if (large) {
    const bucket = getReadMaterialsBucket();
    const uploadStream = bucket.openUploadStream(`${userId}-${Date.now()}.txt`, {
      metadata: { userId, title },
    });
    uploadStream.write(content);
    uploadStream.end();
    await new Promise((resolve, reject) => {
      uploadStream.on("finish", resolve);
      uploadStream.on("error", reject);
    });
    doc.contentId = uploadStream.id as ObjectId;
  } else {
    doc.content = content;
  }
  const result = await collection.insertOne(doc as ReadMaterial);
  return { ...doc, _id: result.insertedId } as ReadMaterial;
}

export async function getReadMaterialContent(material: ReadMaterial): Promise<string> {
  if (material.content) return material.content;

  if (material.r2Key) {
    const obj = await getBlobs().get(material.r2Key);
    return obj ? await obj.text() : "";
  }

  if (material.contentId) {
    const bucket = getReadMaterialsBucket();
    const chunks: Buffer[] = [];
    for await (const chunk of bucket.openDownloadStream(material.contentId)) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf-8");
  }

  return "";
}

export async function deleteReadMaterial(userId: string, materialId: string): Promise<boolean> {
  if (dbBackend() === "d1") {
    const row = await getD1()
      .prepare("SELECT * FROM read_materials WHERE id = ? AND user_id = ?")
      .bind(materialId, userId)
      .first<ReadMaterialRow>();
    if (!row) return false;
    if (row.r2_key) {
      try {
        await getBlobs().delete(row.r2_key);
      } catch {
        // ignore missing object
      }
    }
    await getD1()
      .prepare("DELETE FROM read_materials WHERE id = ? AND user_id = ?")
      .bind(materialId, userId)
      .run();
    return true;
  }

  const collection = getReadMaterialsCollection(userId);
  const bucket = getReadMaterialsBucket();
  const material = await collection.findOne({ _id: new ObjectId(materialId), userId });
  if (!material) return false;
  if (material.contentId) {
    try {
      await bucket.delete(material.contentId);
    } catch {
      // ignore if file doesn't exist
    }
  }
  await collection.deleteOne({ _id: new ObjectId(materialId), userId });
  return true;
}

export async function listReadMaterials(
  userId: string,
  page: number = 1,
  pageSize: number = 10,
): Promise<{ materials: ReadMaterial[]; total: number }> {
  if (dbBackend() === "d1") {
    const d1 = getD1();
    const { results } = await d1
      .prepare(
        "SELECT * FROM read_materials WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .bind(userId, pageSize, (page - 1) * pageSize)
      .all<ReadMaterialRow>();
    const totalRow = await d1
      .prepare("SELECT COUNT(*) AS c FROM read_materials WHERE user_id = ?")
      .bind(userId)
      .first<{ c: number }>();
    return { materials: results.map(rowToMaterial), total: totalRow?.c ?? 0 };
  }

  const collection = getReadMaterialsCollection(userId);
  const [materials, total] = await Promise.all([
    collection
      .find({ userId })
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    collection.countDocuments({ userId }),
  ]);
  return { materials, total };
}

export async function getReadMaterialById(
  userId: string,
  materialId: string,
): Promise<ReadMaterial | null> {
  if (dbBackend() === "d1") {
    const row = await getD1()
      .prepare("SELECT * FROM read_materials WHERE id = ? AND user_id = ?")
      .bind(materialId, userId)
      .first<ReadMaterialRow>();
    return row ? rowToMaterial(row) : null;
  }

  const collection = getReadMaterialsCollection(userId);
  return collection.findOne({ _id: new ObjectId(materialId), userId });
}

/**
 * Replace a material's content in place (a backfill: the book's word count
 * added to its meta). Moves between inline and R2 as the size requires, and
 * leaves `updated_at` alone so the list order does not change. D1 only:
 * MongoDB is the frozen rollback copy, so there it is a no-op.
 */
export async function replaceReadMaterialContent(
  userId: string,
  materialId: string,
  content: string,
): Promise<void> {
  if (dbBackend() !== "d1") return;
  const large = Buffer.byteLength(content, "utf8") >= GRIDFS_THRESHOLD;
  const row = await getD1()
    .prepare("SELECT r2_key FROM read_materials WHERE id = ? AND user_id = ?")
    .bind(materialId, userId)
    .first<{ r2_key: string | null }>();
  if (!row) return;
  if (large) {
    const key = row.r2_key ?? `${R2_PREFIX}${materialId}`;
    await getBlobs().put(key, content);
    await getD1()
      .prepare("UPDATE read_materials SET r2_key = ?, content = NULL WHERE id = ? AND user_id = ?")
      .bind(key, materialId, userId)
      .run();
    return;
  }
  await getD1()
    .prepare("UPDATE read_materials SET r2_key = NULL, content = ? WHERE id = ? AND user_id = ?")
    .bind(content, materialId, userId)
    .run();
  if (row.r2_key) {
    try {
      await getBlobs().delete(row.r2_key);
    } catch {
      // a stray object costs little; the row no longer points at it
    }
  }
}

/**
 * Record the first time a material passed. Only when none is recorded yet:
 * the first pass stands, whatever happens to the coverage later. Returns the
 * date that is recorded now (the existing one if it was already set).
 */
export async function markReadMaterialPassed(
  userId: string,
  materialId: string,
  at: Date,
): Promise<Date | null> {
  if (dbBackend() !== "d1") return null;
  await getD1()
    .prepare(
      "UPDATE read_materials SET passed_at = ? WHERE id = ? AND user_id = ? AND passed_at IS NULL",
    )
    .bind(at.toISOString(), materialId, userId)
    .run();
  const row = await getD1()
    .prepare("SELECT passed_at FROM read_materials WHERE id = ? AND user_id = ?")
    .bind(materialId, userId)
    .first<{ passed_at: string | null }>();
  return row?.passed_at ? new Date(row.passed_at) : null;
}

/**
 * The user's material with exactly these lines (same book hash, or no hash
 * yet and the same stored lines), newest first; null if none. D1 only: the
 * same EPUB imported again upgrades that book in place (docs/books-plan.md,
 * "Review units").
 */
export async function findReadMaterialByText(
  userId: string,
  contentHash: string,
  lines: string[],
): Promise<ReadMaterial | null> {
  if (dbBackend() !== "d1") return null;
  const row = await getD1()
    .prepare(
      `SELECT * FROM read_materials
       WHERE user_id = ? AND (content_hash = ? OR (content_hash IS NULL AND lines = ?))
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, contentHash, JSON.stringify(lines))
    .first<ReadMaterialRow>();
  return row ? rowToMaterial(row) : null;
}

/**
 * The id of the user's own material whose text has this book hash (the
 * content hash a deep link names, lib/read/book-link.ts), newest first; null
 * if the user has none. Looks only at `userId`'s rows. Rows from before the
 * hash was stored are hashed here (and the hash saved), so an old upload
 * still answers its links.
 */
export async function findReadMaterialIdByHash(
  userId: string,
  hash: string,
): Promise<string | null> {
  if (dbBackend() === "d1") {
    const d1 = getD1();
    const hit = await d1
      .prepare(
        "SELECT id FROM read_materials WHERE user_id = ? AND content_hash = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(userId, hash)
      .first<{ id: string }>();
    if (hit) return hit.id;
    const { results } = await d1
      .prepare(
        "SELECT id, lines FROM read_materials WHERE user_id = ? AND content_hash IS NULL ORDER BY updated_at DESC",
      )
      .bind(userId)
      .all<{ id: string; lines: string }>();
    for (const r of results) {
      const h = await bookHash(JSON.parse(r.lines || "[]"));
      try {
        await d1
          .prepare("UPDATE read_materials SET content_hash = ? WHERE id = ? AND user_id = ?")
          .bind(h, r.id, userId)
          .run();
      } catch {}
      if (h === hash) return r.id;
    }
    return null;
  }
  const docs = await getReadMaterialsCollection(userId)
    .find({ userId }, { projection: { _id: 1, lines: 1, contentHash: 1 } })
    .sort({ updatedAt: -1 })
    .toArray();
  for (const d of docs)
    if ((d.contentHash ?? (await bookHash(d.lines ?? []))) === hash) return String(d._id);
  return null;
}

/** The user's material imported from this source (newest first), or null. D1 only. */
export async function findReadMaterialBySource(
  userId: string,
  sourceKey: string,
): Promise<ReadMaterial | null> {
  if (dbBackend() !== "d1") return null;
  const row = await getD1()
    .prepare(
      `SELECT * FROM read_materials WHERE user_id = ? AND source_key = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, sourceKey)
    .first<ReadMaterialRow>();
  return row ? rowToMaterial(row) : null;
}

/**
 * The owner renamed a material (/read row menu). The title is marked as the
 * user's own (`title_custom`), so a re-import of its source keeps it. Leaves
 * `updated_at` alone: renaming is not new reading. False when this user has
 * no such material. `title` must already be clean (lib/read/title.ts).
 */
export async function renameReadMaterial(
  userId: string,
  materialId: string,
  title: string,
): Promise<boolean> {
  if (dbBackend() === "d1") {
    const r = (await getD1()
      .prepare("UPDATE read_materials SET title = ?, title_custom = 1 WHERE id = ? AND user_id = ?")
      .bind(title, materialId, userId)
      .run()) as { meta?: { changes?: number } };
    return (r.meta?.changes ?? 0) > 0;
  }
  if (!ObjectId.isValid(materialId)) return false;
  const res = await getReadMaterialsCollection(userId).updateOne(
    { _id: new ObjectId(materialId), userId },
    { $set: { title } },
  );
  return res.matchedCount > 0;
}

/**
 * A re-imported source: the same material (id, created date, position row)
 * gets the new lines, meta and book hash, and moves to the top of the list.
 * The new title too, unless the user renamed it (`title_custom`). D1 only.
 */
export async function replaceReadMaterialText(
  userId: string,
  materialId: string,
  title: string,
  lines: string[],
  content: string,
  contentHash: string,
): Promise<Date> {
  const now = new Date();
  await replaceReadMaterialContent(userId, materialId, content);
  await getD1()
    .prepare(
      `UPDATE read_materials
       SET title = CASE WHEN title_custom = 1 THEN title ELSE ? END,
           lines = ?, content_hash = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(title, JSON.stringify(lines), contentHash, now.toISOString(), materialId, userId)
    .run();
  return now;
}
