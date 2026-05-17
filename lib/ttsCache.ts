// TTS audio cache — backed by Cloudflare R2 (DB_BACKEND=d1) or MongoDB GridFS.
// Keyed by a sha256 of model:voice:text.

import { Readable } from "stream";
import { dbBackend, getBlobs } from "@/lib/d1";
import { getTTSVoiceCacheBucket } from "@/app/[locale]/read/getReadMaterialsCollection";

const R2_PREFIX = "tts/";

/** Return cached audio bytes for `cacheKey`, or null on a miss. */
export async function getCachedTTS(cacheKey: string): Promise<Uint8Array | null> {
  if (dbBackend() === "d1") {
    const obj = await getBlobs().get(R2_PREFIX + cacheKey);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  const bucket = getTTSVoiceCacheBucket();
  const files = await bucket.find({ filename: cacheKey }).limit(1).toArray();
  if (files.length === 0) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of bucket.openDownloadStreamByName(cacheKey)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Store audio bytes under `cacheKey`. */
export async function putCachedTTS(
  cacheKey: string,
  audio: Uint8Array,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (dbBackend() === "d1") {
    await getBlobs().put(R2_PREFIX + cacheKey, audio, {
      customMetadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
    });
    return;
  }
  const bucket = getTTSVoiceCacheBucket();
  const uploadStream = bucket.openUploadStream(cacheKey, { metadata });
  Readable.from(Buffer.from(audio)).pipe(uploadStream);
  await new Promise<void>((resolve, reject) => {
    uploadStream.on("finish", () => resolve());
    uploadStream.on("error", reject);
  });
}
