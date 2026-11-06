import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { normaliseCode } from "@/lib/referrals/rules";
import { redeemGiftCode, type D1WithBatch } from "@/lib/referrals/store";
import { clientIp, tooMany } from "@/lib/security/route-guard";

/**
 * Tries per user and per IP (D1), every try counted, wrong codes too: a code
 * is a secret worth Pro days or credits, so guessing must stay slow.
 */
const REDEEM_PER_USER = { max: 10, windowMs: 10 * 60_000 };
const REDEEM_PER_IP = { max: 30, windowMs: 10 * 60_000 };

/** `{ code }` → Pro days for the signed-in user, once per person per code. */
export async function POST(req: Request) {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited =
    (await tooMany(`gift-redeem:user:${session.user.id}`, REDEEM_PER_USER)) ??
    (await tooMany(`gift-redeem:ip:${clientIp(req.headers)}`, REDEEM_PER_IP));
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = normaliseCode(body?.code);
  if (!code) return NextResponse.json({ status: "rejected", reason: "unknown code" });
  return NextResponse.json(
    await redeemGiftCode(getD1() as unknown as D1WithBatch, session.user.id, code),
  );
}
