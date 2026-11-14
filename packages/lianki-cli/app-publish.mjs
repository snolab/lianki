// Local input memory bounds, not the service's configurable HTML allowance.
import { open } from "node:fs/promises";

export async function readPublishFile(path, maxBytes) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("publish input must be a regular file within the CLI memory bound");
    // Read at most the bound plus one, including if the file grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > stat.size) throw new Error("publish input changed while being read; try again");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readPublishInput(manifestPath, htmlPath) {
  const manifest = JSON.parse(await readPublishFile(manifestPath, 64 * 1024));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("manifest must be a JSON object");
  const html = await readPublishFile(htmlPath, 16 * 1024 * 1024);
  if (!html.trim()) throw new Error("HTML file is empty");
  return { manifest, html };
}
