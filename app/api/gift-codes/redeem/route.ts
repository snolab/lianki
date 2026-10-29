import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { normaliseCode } from "@/lib/referrals/rules";
import { redeemGiftCode, type D1WithBatch } from "@/lib/referrals/store";

/** `{ code }` → Pro days for the signed-in user, once per person per code. */
export async function POST(req: Request) {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = normaliseCode(body?.code);
  if (!code) return NextResponse.json({ status: "rejected", reason: "unknown code" });
  return NextResponse.json(
    await redeemGiftCode(getD1() as unknown as D1WithBatch, session.user.id, code),
  );
}
