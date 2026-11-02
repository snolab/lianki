import { NextRequest, NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { MembershipD1Repo } from "@/lib/repos/d1Repos";
import { ADMIN_MAX, ADMIN_REASONS, type AdminReason } from "@/lib/payments/credits";
import {
  applyCredit,
  getBalance,
  ledger,
  refundPassToCredits,
  reverseTopup,
  type D1WithBatch,
} from "@/lib/payments/credits-store";

/**
 * Owner-only wallet admin (404 for anyone else; under /api/dev/ so Cloudflare
 * Access covers it). GET ?email= → balance + ledger. POST:
 * - `{ email, action: "credit", amount, reason: sponsor|adjust|gift, note? }`
 *   — a manual entry, + or − (never below 0);
 * - `{ action: "refund-pass", refId }` — a credit-bought pass back to credits;
 * - `{ action: "reverse-topup", refId }` — take back a top-up refunded at the
 *   provider (refused if already spent).
 * Every action is logged.
 */
async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) ? user : null;
}

async function view(email: string) {
  const d1 = getD1();
  const row = await new MembershipD1Repo(d1).getUserByEmail(email);
  if (!row) return null;
  return {
    email: row.email,
    userId: row.id,
    proEndsAt: row.proEndsAt,
    balance: await getBalance(d1, row.id),
    entries: await ledger(d1, row.id, 100),
  };
}

export const GET = async (req: NextRequest) => {
  if (!(await owner()) || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  const email = req.nextUrl.searchParams.get("email")?.trim() ?? "";
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const v = await view(email);
  if (!v) return NextResponse.json({ error: "No account with that email" }, { status: 404 });
  return NextResponse.json(v);
};

export const POST = async (req: NextRequest) => {
  const by = await owner();
  if (!by || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const d1 = getD1() as unknown as D1WithBatch;
  const note = typeof body.note === "string" ? body.note.slice(0, 200) : undefined;
  const log = (result: unknown) =>
    console.log(
      JSON.stringify({ event: "credits.admin", by: by.email, action: body.action, result }),
    );

  if (body.action === "refund-pass" || body.action === "reverse-topup") {
    const refId = typeof body.refId === "string" ? body.refId : "";
    if (!refId) return NextResponse.json({ error: "refId required" }, { status: 400 });
    const r =
      body.action === "refund-pass"
        ? await refundPassToCredits(d1, refId, new Date(), note)
        : await reverseTopup(d1, refId, new Date(), note);
    log(r);
    return NextResponse.json(r, { status: r.status === "not found" ? 404 : 200 });
  }

  if (body.action !== "credit") return NextResponse.json({ error: "Bad action" }, { status: 400 });
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const amount = Number(body.amount);
  const reason = body.reason as AdminReason;
  if (
    !email ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > ADMIN_MAX ||
    !ADMIN_REASONS.includes(reason)
  ) {
    return NextResponse.json(
      { error: `email, a non-zero amount up to ±${ADMIN_MAX}, reason ${ADMIN_REASONS.join("|")}` },
      { status: 400 },
    );
  }
  const row = await new MembershipD1Repo(getD1()).getUserByEmail(email);
  if (!row) return NextResponse.json({ error: "No account with that email" }, { status: 404 });
  const r = await applyCredit(d1, {
    userId: row.id,
    amount,
    reason,
    refId: `admin:${crypto.randomUUID()}`,
    note: note ?? `by ${by.email}`,
  });
  log(r);
  if (r.status === "insufficient")
    return NextResponse.json({ error: "Balance would go negative", ...r }, { status: 409 });
  return NextResponse.json(await view(email));
};
