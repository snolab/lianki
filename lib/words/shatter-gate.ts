/**
 * Who sees the cracked glass on a locked "↓ back" slip (/words,
 * lib/words/shatter.ts): `words.shatter` is an owner-audience flag, on by
 * default. On: the accounts holding the `dev` grant (lib/permissions.ts), so
 * it widens by granting, never by code; off: nobody, the owner included.
 */
import { type FlagValues, flagIn } from "@/lib/flags";

export function shatterOn(flags: FlagValues | null | undefined, dev: boolean): boolean {
  return dev && flagIn(flags, "words.shatter");
}
