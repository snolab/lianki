import { GridFSBucket, ObjectId } from "mongodb";
import { db } from "@/app/db";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";

export interface ReadMaterial {
  _id: ObjectId | string;
  userId: string;
  title: string;
  lines: string[];
  contentId?: ObjectId; // GridFS file ID for large content (MongoDB backend)
  r2Key?: string; // R2 object key for large content (D1 backend)
  content?: string; // Direct content for small materials (<32KB)
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
           (id, user_id, title, lines, r2_key, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        title,
        JSON.stringify(lines),
        r2Key ?? null,
        large ? null : content,
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
