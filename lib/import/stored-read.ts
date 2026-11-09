/**
 * One of a user's own stored files (lib/import/files.ts), its bytes read from
 * R2 into the request only — for the routes that analyse a stored file
 * ("Words with AI", the /self-intro import). Anyone else's file, another
 * source, or no D1/R2: null.
 */
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import type { InboxBucket } from "@/lib/inbox/handlers";
import { getItem, type InboxDb, type InboxSource } from "@/lib/inbox/store";

export type StoredFile = { name: string; type: string; bytes: Uint8Array };

export const storedFileReader =
  (source: InboxSource) =>
  async (userId: string, id: string): Promise<StoredFile | null> => {
    if (dbBackend() !== "d1") return null;
    const it = await getItem(getD1() as unknown as InboxDb, id);
    if (!it || it.ownerId !== userId || it.source !== source) return null;
    const obj = await (getBlobs() as unknown as InboxBucket).get(it.r2Key);
    if (!obj) return null;
    return {
      name: it.name,
      type: it.type,
      bytes: new Uint8Array(await new Response(obj.body).arrayBuffer()),
    };
  };
