import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { QUICK_TOPUPS, TOPUP_MAX, TOPUP_MIN } from "@/lib/payments/credits";
import { getBalance, getTestBalance, ledger, testLedger } from "@/lib/payments/credits-store";
import { providersFor, publicProvider } from "@/lib/payments/providers";

/**
 * The signed-in user's wallet: balance, recent ledger, and the top-up options
 * — only the providers this user may pay through (enabled, and a test-mode
 * one for the owner only).
 */
export async function GET() {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const d1 = getD1();
  const providers = providersFor(session.user.email).map((p) => publicProvider(p));
  // Test-mode top-ups (owner only), kept apart: not part of `balance`, not spendable.
  const testEntries = await testLedger(d1, session.user.id, 50);
  return NextResponse.json({
    ...(testEntries.length
      ? { test: { balance: await getTestBalance(d1, session.user.id), entries: testEntries } }
      : {}),
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
