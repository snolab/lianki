// POST /api/books/mine { file: "<My Files id>" } — the user's own book file,
// stored in My Files under 'books' (POST /api/import/files?source=books),
// becomes their book on /books (lib/books/own-import.ts). Parsed here on the
// server, no AI, no credits; once per file. A file that is not a readable book
// is removed again and the reason returned (422/413). Gate: a session, D1,
// `books.mine` (or `dev`), same-origin.

import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { booksMineOn } from "@/lib/books/gate";
import { importOwnBook } from "@/lib/books/own-import";
import { getItem, type InboxDb } from "@/lib/inbox/store";
import { isInboxId } from "@/lib/inbox/keys";
import { removeFor } from "@/lib/inbox/handlers";
import { inboxDeps } from "@/app/api/dev/inbox/deps";
import { findReadMaterialBySource, saveReadMaterial } from "@/lib/getReadMaterialsCollection";
import { sameOriginWrite } from "@/lib/security/same-origin";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const fail = (error: string, status: number) =>
  Response.json({ error }, { status, headers: NO_STORE });

export async function POST(req: Request) {
  if (!sameOriginWrite(req)) return fail("forbidden", 403);
  const user = await authUserOrNull();
  if (!user?.id) return fail("unauthorized", 401);
  if (dbBackend() !== "d1") return fail("not-found", 404);
  if (!booksMineOn(await readFlags(), isDev(user.email ?? null))) return fail("not-found", 404);
  const body = (await req.json().catch(() => null)) as { file?: unknown } | null;
  const fileId = typeof body?.file === "string" ? body.file : "";
  if (!isInboxId(fileId)) return fail("bad-file", 400);

  const db = getD1() as unknown as InboxDb;
  const r = await importOwnBook(user.id, fileId, {
    file: (id) => getItem(db, id),
    bytes: async (key) => {
      const obj = await getBlobs().get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    find: async (uid, key) => {
      const m = await findReadMaterialBySource(uid, key);
      return m ? { id: String(m._id) } : null;
    },
    save: async (uid, title, content, lines, hash, key) => {
      const m = await saveReadMaterial(uid, title, content, lines, hash, key);
      return { id: String(m._id) };
    },
    putCover: async (key, bytes, type) => {
      await getBlobs().put(key, bytes, { httpMetadata: { contentType: type } });
    },
    dropFile: async (uid, id) => {
      await removeFor(id, { id: uid }, inboxDeps, "books");
    },
  });
  if (!r.ok) return fail(r.error, r.status);
  return Response.json({ id: r.id, existing: r.existing }, { headers: NO_STORE });
}
