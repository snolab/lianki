/**
 * Who may do what in the /read reader. Imports only lib/flags, so the browser
 * can run it (app/(app)/reader/[id]/BoxReader.tsx decides on a box from
 * production's flags).
 */
import { flagIn, type FlagValues } from "@/lib/flags";

/** May this reader start a live draft (the owner, or `read.live-polish`)? */
export function draftAllowedFor(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner || flagIn(flags, "read.live-polish");
}
