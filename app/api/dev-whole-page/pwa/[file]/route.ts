import { readFileSync } from "node:fs";
import { join } from "node:path";
import { devWholePage } from "@/lib/dev-whole-page";
import { devPwaAssets } from "@/lib/dev-site/pwa";

/**
 * The dev site's PWA files (lib/dev-site/pwa.ts): its manifest, service worker
 * and badged icons. /manifest.json and /sw.js reach here through next.config's
 * dev-only rewrite (lib/build/dev-site-rewrites.mjs). 404 unless this is
 * `next dev` under scripts/dev/whole-page.ts, so production never serves them.
 */
const asset = devPwaAssets((name) => readFileSync(join(process.cwd(), "public", name)));

export const GET = async (_req: Request, { params }: { params: Promise<{ file: string }> }) => {
  if (!devWholePage()) return new Response(null, { status: 404 });
  const a = asset((await params).file);
  if (!a) return new Response(null, { status: 404 });
  return new Response(a.body as BodyInit, {
    headers: { "content-type": a.type, "cache-control": "no-cache" },
  });
};
