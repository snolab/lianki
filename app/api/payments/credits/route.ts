import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { QUICK_TOPUPS, TOPUP_MAX, TOPUP_MIN } from "@/lib/payments/credits";
import { getBalance, ledger } from "@/lib/payments/credits-store";
import { enabledProviders, publicProvider } from "@/lib/payments/providers";

/**
 * The signed-in user's wallet: balance, recent ledger, and the top-up options
 * — only the providers that are enabled (implemented + secrets set).
 */
export async function GET() {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const d1 = getD1();
  const providers = enabledProviders().map(publicProvider);
  return NextResponse.json({
    balance: await getBalance(d1, session.user.id),
    entries: await ledger(d1, session.user.id, 50),
    topup: {
      min: TOPUP_MIN,
      max: TOPUP_MAX,
      quick: QUICK_TOPUPS,
      providers: providers.filter((p) => p.kind === "checkout"),
    },
    grants: providers.filter((p) => p.kind === "grant"),
  });
}
