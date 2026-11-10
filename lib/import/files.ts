/**
 * The user's own file store (docs/import-material.md, "Any file: stored, not
 * processed"; /my/files): a signed-in user uploads a file of any type; it is
 * kept in R2 as their own (the chat inbox's storage, one `inbox_item` row with
 * its `source`), listed back with name, size and time, served back to them
 * only, and deleted when they say so.
 *
 * - **Sources.** `import` (the /words Import panel), `self-intro` (the
 *   /self-intro add-file area), `books` (an own book on /books, gate `books.mine`). `chat` (the chat's attachments) is listed and
 *   deletable on /my/files, never uploaded here.
 * - **Gate.** `import.any` through `importAnyOn` (lib/import/words-handler.ts):
 *   a flag (on: every signed-in user; off: `dev` holders), never an email.
 * - **Limits.** The inbox's (lib/inbox/config.ts): one file, a rolling day,
 *   the stored total, uploads per minute.
 * - **Private.** Only the uploader lists, reads or deletes their files (any
 *   other account: 404); there is no shared or public URL; the R2 key is
 *   `inbox/<user>/<yyyy>/<mm>/<random id>` (lib/inbox/keys.ts) and never
 *   served; the name is display text, never in a log or a key. Writes are
 *   same-origin only (lib/security/same-origin.ts).
 */
import { type InboxDeps, listFor, removeFor, serveOwn, storeUpload } from "@/lib/inbox/handlers";
import { type InboxSource, listAllItems } from "@/lib/inbox/store";
import { sameOriginWrite } from "@/lib/security/same-origin";

export type ImportFilesDeps = InboxDeps & {
  /**
   * The gate for this signed-in user and source: `importAnyOn(flags, isDev(email))`;
   * `books` (an own book on /books) is `books.mine`'s; `any` (a listing of every
   * source) either.
   */
  on: (who: { id: string; email: string }, source?: UploadSource | "any") => Promise<boolean>;
  /** False without R2/D1 (the Mongo backend): nothing can be stored. */
  available?: boolean;
  /** Drop what was derived from a deleted file (its cached AI chunks). */
  dropDerived?: (userId: string, fileId: string) => Promise<void>;
};

/** After a delete answered 200: what was derived from the file goes too. */
async function dropAfter(r: Response, d: ImportFilesDeps, userId: string, id: string) {
  if (r.ok && d.dropDerived) await d.dropDerived(userId, id);
  return r;
}

/** The sources a user uploads to through these routes (`?source=`; default `import`). */
export const UPLOAD_SOURCES = [
  "import",
  "self-intro",
  "books",
  // The voiceprint's enrolment recordings (the Voiceprint panel; gate stt.voiceprint-cloud + dev).
  "voiceprint",
] as const satisfies readonly InboxSource[];
export type UploadSource = (typeof UPLOAD_SOURCES)[number];

/** The `source` query parameter, checked: an upload source, else null (400). */
export function uploadSourceOf(req: Request): UploadSource | null {
  const s = new URL(req.url).searchParams.get("source") ?? "import";
  return (UPLOAD_SOURCES as readonly string[]).includes(s) ? (s as UploadSource) : null;
}

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
const unauthorized = () =>
  Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

/** The signed-in user the gate lets in, or null (→ 401 / 404 by the caller). */
async function allowed(d: ImportFilesDeps, source: UploadSource | "any" = "import") {
  const who = await d.who();
  if (!who?.id) return { who: null, ok: false } as const;
  return { who, ok: d.available !== false && (await d.on(who, source)) } as const;
}

/** POST /api/import/files?source=import|self-intro — the raw bytes; `x-file-name` (URI-encoded). */
export async function uploadImportFile(req: Request, d: ImportFilesDeps): Promise<Response> {
  if (!sameOriginWrite(req)) return forbidden();
  const source = uploadSourceOf(req);
  const a = await allowed(d, source ?? "import");
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  if (!source) return Response.json({ error: "bad-source" }, { status: 400, headers: NO_STORE });
  return storeUpload(req, a.who, d, source);
}

/** GET /api/import/files?source= — the user's stored files from one source, newest first, and usage. */
export async function listImportFiles(d: ImportFilesDeps, req?: Request): Promise<Response> {
  const source = req ? uploadSourceOf(req) : "import";
  const a = await allowed(d, source ?? "import");
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  if (!source) return Response.json({ error: "bad-source" }, { status: 400, headers: NO_STORE });
  return listFor(a.who, d, source);
}

/** DELETE /api/import/files/<id> — one of the user's own Import-panel files, for good. */
export async function deleteImportFile(
  req: Request,
  id: string,
  d: ImportFilesDeps,
): Promise<Response> {
  if (!sameOriginWrite(req)) return forbidden();
  const a = await allowed(d);
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  return dropAfter(await removeFor(id, a.who, d, "import"), d, a.who.id, id);
}

/** GET /api/my/files — every file the user stored, every source, newest first (/my/files). */
export async function listMyFiles(d: ImportFilesDeps): Promise<Response> {
  const a = await allowed(d, "any");
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  const items = await listAllItems(d.db(), a.who.id);
  return Response.json(
    {
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        size: i.size,
        at: i.createdMs,
        source: i.source,
      })),
    },
    { headers: NO_STORE },
  );
}

/** GET /api/my/files/<id> — one of the user's own files, to them only (else 404). */
export async function readMyFile(id: string, d: ImportFilesDeps): Promise<Response> {
  const a = await allowed(d, "any");
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  return serveOwn(id, a.who, d);
}

/** DELETE /api/my/files/<id> — one of the user's own files, any source, for good (R2 + row). */
export async function deleteMyFile(
  req: Request,
  id: string,
  d: ImportFilesDeps,
): Promise<Response> {
  if (!sameOriginWrite(req)) return forbidden();
  const a = await allowed(d, "any");
  if (!a.who) return unauthorized();
  if (!a.ok) return notFound();
  return dropAfter(await removeFor(id, a.who, d, null), d, a.who.id, id);
}
