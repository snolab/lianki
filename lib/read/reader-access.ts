/**
 * Which reader /read/[id] shows (docs/books-plan.md): the reader v2 by the
 * same rule as its backend (readerV2On, which lib/read/reader-book.ts
 * re-exports): the `read.reader-v2` flag is on, or the reader is the owner
 * (in production too). Everyone else needs the flag. `?reader=v1` /
 * `?reader=v2` choose for one page load — v2 only for the owner, or on a local
 * dev server (QA). Decided on the server, handed to the page; on a box, in the
 * browser from production's flags (app/(app)/read/[id]/ReaderChoice.tsx).
 * Imports only lib/flags, so the browser can run it.
 */
import { flagIn, type FlagValues } from "@/lib/flags";

export type ReaderPick = "v1" | "v2";

/** Reader v2 for this user: the flag for everyone, else the owner alone. */
export function readerV2On(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, "read.reader-v2") || owner;
}

/** May this reader start a live draft (the owner, or `read.live-polish`)? */
export function draftAllowedFor(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner || flagIn(flags, "read.live-polish");
}

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
