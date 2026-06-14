import type { Collection } from "mongodb";
import type { FSRSNote } from "@/app/fsrs";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { D1FsrsCollection } from "@/app/fsrsNotesD1Collection";

/**
 * Backend-aware FSRS notes collection. Returns the MongoDB collection, or the
 * D1-backed shim cast to the same shape, per `DB_BACKEND`. Use this anywhere
 * (SSR pages, server components) that needs notes — the mongo driver is stubbed
 * in the Cloudflare build, so a direct `getFSRSNotesCollection` 500s on D1.
 *
 * Mirrors the private `getFsrsNotes` in app/fsrs.ts so both backends share one
 * switch.
 */
export function getNotesCollection(email?: string): Collection<FSRSNote> {
  if (dbBackend() === "d1") {
    return new D1FsrsCollection(getD1(), email ?? "") as unknown as Collection<FSRSNote>;
  }
  return getFSRSNotesCollection(email);
}
