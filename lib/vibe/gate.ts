// Who may start /vibe (docs/vibe.md). Client-safe: no D1 here.
//
// Both halves are needed. The flag has NO owner bypass, unlike every other
// rollout flag (the owner turns it on separately, after his own tap card), and
// the voice front end stays owner-only, the same `isOwner` the local STT's
// ticket route uses (docs/local-stt.md).
import { flagIn, type FlagKey, type FlagValues } from "@/lib/flags";

export const VIBE_FLAG: FlagKey = "read.vibe";

export function vibeAllowed(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, VIBE_FLAG) && owner;
}

/** The owner's choice: 30 days unless the user sets another number. */
export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

/** A retention from the outside: a whole number of days in range, else null. */
export function checkRetention(v: unknown): number | null {
  return Number.isInteger(v) &&
    (v as number) >= RETENTION_MIN_DAYS &&
    (v as number) <= RETENTION_MAX_DAYS
    ? (v as number)
    : null;
}
