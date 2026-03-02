import { GridFSBucket, ObjectId } from "mongodb";
import { db } from "@/app/db";

export interface ReadMaterial {
  _id: ObjectId;
  userId: string;
  title: string;
  lines: string[];
  contentId?: ObjectId; // GridFS file ID for large content (>=32KB)
  content?: string; // Direct content for small materials (<32KB)
  createdAt: Date;
  updatedAt: Date;
}

const GRIDFS_THRESHOLD = 32 * 1024; // 32KB

export function getReadMaterialsCollection(userId: string) {
  return db.collection<ReadMaterial>("readMaterials");
}

export function getReadMaterialsBucket() {
  return new GridFSBucket(db, { bucketName: "readMaterialsContent" });
}

export function getTTSVoiceCacheBucket() {
  return new GridFSBucket(db, { bucketName: "ttsVoiceCache" });
}

export async function saveReadMaterial(
  userId: string,
  title: string,
  content: string,
  lines: string[],
): Promise<ReadMaterial> {
  const collection = getReadMaterialsCollection(userId);
  const bucket = getReadMaterialsBucket();
  const now = new Date();

  const doc: Omit<ReadMaterial, "_id"> = {
    userId,
    title,
    lines,
    createdAt: now,
    updatedAt: now,
  };

  // Use GridFS for large content
  if (content.length >= GRIDFS_THRESHOLD) {
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
  if (material.content) {
    return material.content;
  }

  if (material.contentId) {
    const bucket = getReadMaterialsBucket();
    const downloadStream = bucket.openDownloadStream(material.contentId);
    const chunks: Buffer[] = [];
    for await (const chunk of downloadStream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  return "";
}

export async function deleteReadMaterial(userId: string, materialId: string): Promise<boolean> {
  const collection = getReadMaterialsCollection(userId);
  const bucket = getReadMaterialsBucket();

  const material = await collection.findOne({
    _id: new ObjectId(materialId),
    userId,
  });

  if (!material) return false;

  // Delete GridFS content if exists
  if (material.contentId) {
    try {
      await bucket.delete(material.contentId);
    } catch {
      // Ignore if file doesn't exist
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
  const collection = getReadMaterialsCollection(userId);
  return collection.findOne({
    _id: new ObjectId(materialId),
    userId,
  });
}
