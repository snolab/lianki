import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { QUICK_TOPUPS, TOPUP_MAX, TOPUP_MIN } from "@/lib/payments/credits";
import {
  getBalance,
  getTestBalance,
  ledger,
  testLedger,
  type D1WithBatch,
} from "@/lib/payments/credits-store";
import { runSignupBonus, type SignupBonusDb } from "@/lib/payments/signup-bonus-store";
import { loginStreakView, type StreakView } from "@/lib/payments/login-streak-store";
import { homeDay, requestTimeZone } from "@/lib/study-days";
import { pendingHolds, sweepStaleAi } from "@/lib/payments/ai-credits";
import { HOLD_STALE_MS } from "@/lib/payments/metered";
import { readFlags } from "@/lib/flags-store";
import { providersFor, publicProvider } from "@/lib/payments/providers";

/**
 * The signed-in user's wallet: balance, recent ledger, and the top-up options
 * — only the providers this user may pay through (enabled, and a test-mode
 * one for the owner only).
 */
export async function GET() {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "login-required" }, { status: 401 });
  const d1 = getD1();
  // Expired holds of this wallet are released on its next read (no timer).
  try {
    await sweepStaleAi(
      d1 as unknown as D1WithBatch,
      HOLD_STALE_MS,
      new Date(),
      20,
      session.user.id,
    );
  } catch {}
  const flags = await readFlags();
  // The sign-up bonus backfill (docs/payments.md, "Sign-up bonus"): an account
  // older than the feature gets it once, before the balance is read. Never throws.
  await runSignupBonus(d1 as unknown as SignupBonusDb, session.user.id, "backfill", {
    enabled: async () => flags["credits.signup-bonus"] === true,
  });
  // The login streak (docs/payments.md, "Login-streak bonus"): read only —
  // a day counts on a real learning action, never on a wallet read.
  let streak: StreakView | null = null;
  if (flags["credits.login-streak"])
    try {
      const now = new Date();
      const d = await homeDay(d1, session.user.email, now, requestTimeZone());
      streak = await loginStreakView(d1, session.user.id, d.day);
    } catch (e) {
      console.error("[login-streak] view:", e);
    }
  const providers = providersFor(session.user.email, process.env, flags).map((p) =>
    publicProvider(p, process.env, flags),
  );
  // Test-mode top-ups (owner only), kept apart: not part of `balance`, not spendable.
  const testEntries = await testLedger(d1, session.user.id, 50);
  return NextResponse.json({
    ...(testEntries.length
      ? { test: { balance: await getTestBalance(d1, session.user.id), entries: testEntries } }
      : {}),
    // Spendable now; `held` is what calls in progress hold (balance + held = total).
    balance: await getBalance(d1, session.user.id),
    held: await pendingHolds(d1 as unknown as D1WithBatch, session.user.id).catch(() => 0),
    entries: await ledger(d1, session.user.id, 50),
    ...(streak ? { streak } : {}),
    topup: {
      min: TOPUP_MIN,
      max: TOPUP_MAX,
      quick: QUICK_TOPUPS,
      providers: providers.filter((p) => p.kind === "checkout"),
    },
    grants: providers.filter((p) => p.kind === "grant"),
  });
}
