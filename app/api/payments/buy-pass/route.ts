import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { spendKey } from "@/lib/payments/credits";
import { buyPassWithCredits, type D1WithBatch } from "@/lib/payments/credits-store";
import { rewardPurchase } from "@/lib/referrals/store";

/**
 * Buy a pass with the wallet balance: `{ passId, key }` → 200 with the new
 * balance and `proEndsAt`, or 402 `{ balance, price, missing }` so the page can
 * offer a top-up of exactly `missing`. `key` is one idempotency key per click.
 * No card is involved, so no Turnstile: the money came in through a guarded
 * top-up.
 */
export async function POST(req: Request) {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { passId?: unknown; key?: unknown } | null;
  const key = spendKey(body?.key) ?? crypto.randomUUID();
  const d1 = getD1() as unknown as D1WithBatch;
  const r = await buyPassWithCredits(d1, session.user.id, body?.passId, key);
  if (r.status === "rejected") return NextResponse.json(r, { status: 400 });
  if (r.status === "insufficient") return NextResponse.json(r, { status: 402 });
  if (r.status === "applied") {
    // The inviter's first-pass bonus counts a pass bought with credits too.
    await rewardPurchase(d1, session.user.id).catch((e) =>
      console.error("[payments] referral bonus:", e),
    );
  }
  return NextResponse.json(r);
}
