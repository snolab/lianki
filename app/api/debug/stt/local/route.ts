import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getD1, workerWaitUntil } from "@/lib/d1";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import {
  LOCAL_STT_MAX_REPORTS,
  LOCAL_STT_WINDOW_MS,
  handleLocalSttCost,
} from "@/lib/payments/cost-ledger";
import { checkRateLimit } from "@/lib/rateLimit";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * One utterance served by Lianki's speech server, booked to this account's
 * cost ledger at the cloud-equivalent rate (lib/payments/cost-ledger.ts;
 * docs/payments.md, "Cost ledger"). Charges nothing.
 */
export const POST = async (req: Request) => {
  // The owner's dev server may ask as the owner (lib/dev-bridge-user.ts).
  const bridged = await devBridgeUser(req);
  // A page's report: same-origin JSON only, so no other site can book on its behalf.
  if (bridged === undefined && !sameOriginJsonPost(req))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const user = bridged === undefined ? await authUserOrNull() : bridged;
  return handleLocalSttCost(req, {
    user: user?.id ? { id: user.id } : null,
    db: dbBackend() === "d1" ? getD1() : null,
    perMinUsd: () => cfg("stt.local.costPerMinUsd"),
    limit: (key) =>
      checkRateLimit(key, { windowMs: LOCAL_STT_WINDOW_MS, max: LOCAL_STT_MAX_REPORTS }),
    defer: workerWaitUntil,
  });
};
