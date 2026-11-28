/**
 * A flag as one account sees it: its switch AND its audience (lib/flags.ts,
 * `audience`). docs/feature-flags.md, "Insiders first".
 *
 * - no audience: on for everyone once the switch is on.
 * - "insider": on only where `isInsider` (the `insider` grant, or `admin`).
 * - "owner": on only where `isDev`, the same check those call sites make.
 * - "allowlist": always false here. The list belongs to the flag's own page
 *   and only its call site can read it, so this helper fails closed rather
 *   than guess.
 *
 * Grants come from the permission snapshot (lib/permissions.ts), so this is
 * for server code after the session was read (it refreshes the snapshot). On a
 * client it has no grants and answers false for every audience.
 */
import {
  FLAGS,
  flagIn,
  type FlagAudience,
  type FlagDef,
  type FlagKey,
  type FlagValues,
} from "./flags";
import { isDev, isInsider } from "./permissions";

/** Does `email`'s account belong to `key`'s audience? Says nothing about the switch. */
export function inFlagAudience(
  key: FlagKey,
  email: string | null | undefined,
  now?: number,
): boolean {
  return audienceAllows((FLAGS[key] as FlagDef).audience, email, now);
}

/** Is `email`'s account in `audience` (undefined = everyone)? Fails closed. */
export function audienceAllows(
  audience: FlagAudience | undefined,
  email: string | null | undefined,
  now?: number,
): boolean {
  switch (audience) {
    case undefined:
      return true;
    case "insider":
      return isInsider(email, now);
    case "owner":
      return isDev(email, now);
    case "allowlist":
      return false;
  }
}

/** On for this account: the switch is on and the account is in the flag's audience. */
export function flagOnFor(
  flags: FlagValues | null | undefined,
  key: FlagKey,
  email: string | null | undefined,
  now?: number,
): boolean {
  return flagIn(flags, key) && inFlagAudience(key, email, now);
}
