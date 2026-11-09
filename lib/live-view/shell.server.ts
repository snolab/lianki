import type { LiveViewLabels, LiveViewShell } from "@/app/components/LiveView";
import { dbBackend, getD1 } from "@/lib/d1";
import { isDev } from "@/lib/permissions";
import { liveViewKeys } from "./keys";
import { LIVE_VIEW_COOKIE, liveLabel } from "./rules";
import { currentPointer } from "./server";

/**
 * What the app layout gives the shell for live view (docs/live-view.md):
 * nothing for anyone but the owner. For the owner, the switch's state (his
 * device's cookie), whether a valid pointer is stored (its branch@sha, so the
 * menu offers the chip only when there is something to load), and — only
 * while the switch is on — the pointer itself, which the server has verified
 * (signature, expiry) before the page verifies it again. D1 is read for the
 * owner only: one row, by id.
 */
export async function liveViewFor(
  email: string | null | undefined,
  cookie: string | undefined,
  labels: () => LiveViewLabels,
): Promise<LiveViewShell | undefined> {
  if (!isDev(email)) return undefined;
  const wanted = cookie === "1";
  let token: string | null = null;
  let ready: string | null = null;
  if (dbBackend() === "d1") {
    try {
      const cur = await currentPointer(
        getD1(),
        await liveViewKeys(),
        Date.now(),
        process.env.NODE_ENV !== "production",
      );
      if (cur) ready = liveLabel(cur.claim);
      if (wanted) token = cur?.token ?? null;
    } catch {
      // No table yet (migration not applied) or D1 down: the page stays normal.
    }
  }
  return { wanted, token, ready, labels: labels() };
}

export { LIVE_VIEW_COOKIE };
