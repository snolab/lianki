import type { LiveViewLabels, LiveViewShell } from "@/app/components/LiveView";
import { dbBackend, getD1 } from "@/lib/d1";
import { isOwner } from "@/lib/owner";
import { liveViewKeys } from "./keys";
import { LIVE_VIEW_COOKIE } from "./rules";
import { currentPointer } from "./server";

/**
 * What the app layout gives the shell for live view (docs/live-view.md):
 * nothing for anyone but the owner. For the owner, the switch's state (his
 * device's cookie) and — only while it is on — the stored pointer, which the
 * server has verified (signature, expiry) before the page verifies it again.
 * D1 is read only for the owner with the switch on.
 */
export async function liveViewFor(
  email: string | null | undefined,
  cookie: string | undefined,
  labels: () => LiveViewLabels,
): Promise<LiveViewShell | undefined> {
  if (!isOwner(email)) return undefined;
  const wanted = cookie === "1";
  let token: string | null = null;
  if (wanted && dbBackend() === "d1") {
    try {
      token =
        (
          await currentPointer(
            getD1(),
            await liveViewKeys(),
            Date.now(),
            process.env.NODE_ENV !== "production",
          )
        )?.token ?? null;
    } catch {
      // No table yet (migration not applied) or D1 down: the page stays normal.
    }
  }
  return { wanted, token, labels: labels() };
}

export { LIVE_VIEW_COOKIE };
