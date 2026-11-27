/**
 * Images in a /roadmap doc step. A pasted or chosen image goes through the
 * user's own file store (lib/import/files.ts, source `roadmap`: R2, the
 * account's file space `files.quotaBytes`, listed on /my/files) and the
 * Markdown gets its site address, `/api/my/files/<id>` (served to its owner
 * only). When the file space is full the image is refused with a hint to free
 * space on /my/files; the Markdown is left exactly as it was, and writing and
 * saving it go on as before — the doc text never depends on the image store.
 */
import { uploadFile, type UploadResult } from "@/lib/import/uploads-client";

/** Where the learner frees space. */
export const FILES_PAGE = "/my/files";

/** The address an uploaded image is shown from. */
export const imageSrc = (id: string) => `/api/my/files/${encodeURIComponent(id)}`;

/** Alt text from a file name: no extension, no brackets that would break the Markdown. */
export function altOf(name: string): string {
  return (
    name
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/[[\]\n\r]/g, " ")
      .trim()
      .slice(0, 80) || "image"
  );
}

/** `md` with `![alt](src)` inserted at `at` (a caret offset), on its own line. */
export function insertImage(
  md: string,
  at: number,
  alt: string,
  src: string,
): { md: string; caret: number } {
  const pos = Math.max(0, Math.min(md.length, at));
  const before = md.slice(0, pos);
  const after = md.slice(pos);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const tail = after && !after.startsWith("\n") ? "\n" : "";
  const piece = `${lead}![${alt}](${src})${tail}`;
  return { md: before + piece + after, caret: pos + piece.length };
}

export type ImageOutcome =
  | { ok: true; md: string; caret: number }
  /** Not added: `md` is the Markdown unchanged. `full`: the file space is full (link to FILES_PAGE). */
  | { ok: false; md: string; reason: Exclude<UploadResult, { ok: true }>["error"] };

/** What an upload's result does to the Markdown. Pure: tested without a network. */
export function applyImageUpload(
  md: string,
  at: number,
  name: string,
  result: UploadResult,
): ImageOutcome {
  if (!result.ok) return { ok: false, md, reason: result.error };
  return { ok: true, ...insertImage(md, at, altOf(name), imageSrc(result.id)) };
}

/** Only images are taken into a doc. */
export const isImageFile = (f: { type: string }) => f.type.startsWith("image/");

/** Upload one image to the store and work out the new Markdown. */
export async function addDocImage(
  file: Blob & { name: string; type: string },
  md: string,
  at: number,
  upload: typeof uploadFile = uploadFile,
): Promise<ImageOutcome> {
  if (!isImageFile(file)) return { ok: false, md, reason: "failed" };
  const result = await upload(file, "roadmap", () => {}).done;
  return applyImageUpload(md, at, file.name || "image", result);
}

/** A pasted /reader link or a bare id → the doc's readerId; anything else → "". */
export function readerIdOf(v: string): string {
  const s = v.trim();
  const m = s.match(/\/reader\/([A-Za-z0-9_-]{1,100})(?:[/?#]|$)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{1,100}$/.test(s) ? s : "";
}
