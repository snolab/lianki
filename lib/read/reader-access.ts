/**
 * Which reader /read/[id] shows (docs/books-plan.md): the reader v2 by the
 * same rule as its backend (lib/read/reader-book.ts readerV2On): the
 * `read.reader-v2` flag is on, or the reader is the owner (in production
 * too). Everyone else needs the flag. `?reader=v1` / `?reader=v2` choose for
 * one page load — v2 only for the owner, or on a local dev server (QA).
 * Decided on the server, handed to the page.
 */
import type { FlagValues } from "@/lib/flags";
import { readerV2On } from "./reader-book";

export type ReaderPick = "v1" | "v2";

export function readerPick(o: {
  flags: FlagValues | null | undefined;
  owner: boolean;
  /** NODE_ENV is development (a local dev server). */
  dev: boolean;
  /** The `?reader=` query, if any. */
  query?: string | string[] | null;
}): ReaderPick {
  const q = Array.isArray(o.query) ? o.query[0] : o.query;
  if (q === "v1") return "v1";
  if (q === "v2" && (o.owner || o.dev)) return "v2";
  return readerV2On(o.flags, o.owner) ? "v2" : "v1";
}
