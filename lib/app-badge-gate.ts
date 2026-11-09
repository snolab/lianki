/**
 * Who gets the app-icon badge (docs/app-badge.md): `pwa.app-badge` is an
 * owner-audience flag. On: the owner only (`isDev`, the permission grant);
 * off: nobody, the owner included. Later an allowlist may widen it here.
 *
 * One gate for /api/badge, the Settings row and the page's AppBadge, so the
 * three never disagree.
 */
import { type FlagValues, flagIn } from "@/lib/flags";

export function appBadgeOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner && flagIn(flags, "pwa.app-badge");
}
