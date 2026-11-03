/**
 * Which reader /read/[id] shows (docs/books-plan.md): the reader v2 once the
 * `read.reader-v2` flag is on; with it off, the owner sees it on the
 * whole-page dev server (docs/dev-whole-page.md) as a preview. `?reader=v1`
 * / `?reader=v2` choose for one page load — v2 only for the owner, or on a
 * local dev server (QA). Decided on the server, handed to the page.
 */
import { type FlagValues, flagIn } from "@/lib/flags";

export type ReaderPick = "v1" | "v2";

export function readerPick(o: {
  flags: FlagValues | null | undefined;
  owner: boolean;
  /** The whole-page dev server is serving this request (lib/dev-whole-page.ts). */
  devPreview: boolean;
  /** NODE_ENV is development (a local dev server). */
  dev: boolean;
  /** The `?reader=` query, if any. */
  query?: string | string[] | null;
}): ReaderPick {
  const q = Array.isArray(o.query) ? o.query[0] : o.query;
  if (q === "v1") return "v1";
  if (q === "v2" && (o.owner || o.dev)) return "v2";
  if (flagIn(o.flags, "read.reader-v2")) return "v2";
  return o.owner && o.devPreview ? "v2" : "v1";
}
