// GET /api/books/mine/<book id>/cover — the cover of a book the user imported
// from their own file (lib/books/own-import.ts), to them only: any other
// account, a book without a cover, or one not from a file is 404. A raster
// image as checked at import, never sniffed by the browser, kept privately.

import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { booksMineOn } from "@/lib/books/gate";
import { coverKey } from "@/lib/books/own-import";
import { COVER_TYPES } from "@/lib/epub/cover";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () =>
  Response.json({ error: "not-found" }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(_req: Request, ctx: Ctx) {
  const user = await authUserOrNull();
  if (!user?.id || dbBackend() !== "d1") return notFound();
  if (!booksMineOn(await readFlags(), isDev(user.email ?? null))) return notFound();
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return notFound();
  const row = await getD1()
    .prepare(`SELECT source_key FROM read_materials WHERE id = ? AND user_id = ?`)
    .bind(id, user.id)
    .first<{ source_key: string | null }>();
  const key = row?.source_key ?? "";
  if (!key.startsWith("file:")) return notFound();
  const obj = await getBlobs().get(coverKey(user.id, key.slice("file:".length)));
  const type = obj?.httpMetadata?.contentType ?? "";
  if (!obj || !Object.hasOwn(COVER_TYPES, type)) return notFound();
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}
