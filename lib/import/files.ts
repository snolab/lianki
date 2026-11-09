/**
 * The Import panel's "Any file" (docs/import-material.md, "Any file: stored,
 * not processed"): a signed-in user uploads a file of any type; it is kept
 * in R2 as their own (the chat inbox's storage, `source = 'import'`), listed
 * back with name, size and time, and deleted when they say so. Nothing reads
 * or converts it yet.
 *
 * - **Gate.** `import.any` through `importAnyOn` (lib/import/words-handler.ts),
 *   the same gate as the rest of the Import panel: a flag, never an email.
 * - **Limits.** The inbox's (lib/inbox/config.ts): one file, a rolling day,
 *   the stored total, uploads per minute.
 * - **Private.** Only the uploader lists or deletes their files; the name is
 *   display text, never in a log or an R2 key; the bytes are never served
 *   back as a page. Writes are same-origin only (lib/security/same-origin.ts).
 */
import { type InboxDeps, listFor, removeFor, storeUpload } from "@/lib/inbox/handlers";
import { sameOriginWrite } from "@/lib/security/same-origin";

export type ImportFilesDeps = InboxDeps & {
  /** The gate for this signed-in user: `importAnyOn(flags, isDev(email))`. */
  on: (who: { id: string; email: string }) => Promise<boolean>;
  /** False without R2/D1 (the Mongo backend): nothing can be stored. */
  available?: boolean;
};

const notFound = () =>
  Response.json({ error: "not-found" }, { status: 404, headers: { "cache-control": "no-store" } });

/** The signed-in user the gate lets in, or null (→ 401 / 404 by the caller). */
async function allowed(d: ImportFilesDeps) {
  const who = await d.who();
  if (!who?.id) return { who: null, ok: false } as const;
  return { who, ok: d.available !== false && (await d.on(who)) } as const;
}

const forbidden = () =>
  Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
const unauthorized = () =>
  Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );

/** POST /api/import/files — the raw bytes; `x-file-name` (URI-encoded). */
export async function uploadImportFile(req: Request, d: ImportFilesDeps): Promise<Response> {
  if (!sameOriginWrite(req)) return forbidden();
  const a = await allowed(d);
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  return storeUpload(req, a.who, d, "import");
}

/** GET /api/import/files — the user's stored files, newest first, and their usage. */
export async function listImportFiles(d: ImportFilesDeps): Promise<Response> {
  const a = await allowed(d);
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  return listFor(a.who, d, "import");
}

/** DELETE /api/import/files/<id> — one of the user's own stored files, for good. */
export async function deleteImportFile(
  req: Request,
  id: string,
  d: ImportFilesDeps,
): Promise<Response> {
  if (!sameOriginWrite(req)) return forbidden();
  const a = await allowed(d);
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  return removeFor(id, a.who, d, "import");
}
