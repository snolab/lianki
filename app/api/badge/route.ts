import { NextRequest, NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { appBadgeOn } from "@/lib/app-badge-gate";
import { isDev } from "@/lib/permissions";
import { readFlags } from "@/lib/flags-store";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";
import { badgeCount, isBadgeMode, parseBadgeMode } from "@/lib/app-badge";
import { badgeCounts } from "@/lib/app-badge-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET /api/badge[?mode=off|ask-cards|due-cards|both] — the numbers behind the
 * app-icon badge (docs/app-badge.md), for the page (AppBadge.tsx) and the
 * service worker (public/sw.js, on a push without counts).
 *
 *   → { on: true, mode, asks, due, count }   numbers only, no text or ids
 *   → { on: false }                          flag `pwa.app-badge` off, not the owner (appBadgeOn), or not D1
 *   → 401                                    signed out
 *
 * `mode` is the page's own copy of `notify.badge`; without it (the worker),
 * the account's synced value. Counts are cached per isolate for 15 s
 * (lib/app-badge-server.ts); the answer itself is never cached.
 */
export async function GET(req: NextRequest) {
  const user = await authUserOrNull();
  if (!user?.id || !user.email)
    return NextResponse.json({ error: "login-required" }, { status: 401, headers: NO_STORE });
  if (dbBackend() !== "d1" || !appBadgeOn(await readFlags(), isDev(user.email)))
    return NextResponse.json({ on: false }, { headers: NO_STORE });
  const db = getD1();
  const asked = req.nextUrl.searchParams.get("mode");
  const mode = isBadgeMode(asked)
    ? asked
    : parseBadgeMode(await new UserPrefsD1Repo(db, user.id).value("notify.badge"));
  const counts = await badgeCounts(db, { id: user.id, email: user.email }, mode);
  return NextResponse.json(
    { on: true, mode, ...counts, count: badgeCount(mode, counts) },
    { headers: NO_STORE },
  );
}
