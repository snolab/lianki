// The shared source cache in R2 (`lianki-blobs`, prefix `preset-cache/`):
// one copy of each catalogue book's source file for every user. Server only.

import { getBlobs } from "@/lib/d1";
import type { SourceCache } from "./source";

export function r2SourceCache(): SourceCache | null {
  let blobs: ReturnType<typeof getBlobs>;
  try {
    blobs = getBlobs();
  } catch {
    return null;
  }
  if (!blobs) return null;
  return {
    async get(key) {
      const obj = await blobs.get(key);
      return obj ? await obj.text() : null;
    },
    async put(key, text) {
      await blobs.put(key, text, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    },
  };
}
