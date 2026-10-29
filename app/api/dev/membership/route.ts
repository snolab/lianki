import { NextRequest, NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { MembershipD1Repo } from "@/lib/repos/d1Repos";
import { extendPro, toDate, tierFor } from "@/lib/membership";

/**
 * The owner grants Pro by hand — to themselves for testing, or to a friend:
 * GET ?email= shows an account's membership, POST {email, days} extends its
 * Pro. Owner only; anyone else gets a 404. Every grant is logged.
 */
const MAX_DAYS = 3660;

async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) ? user : null;
}

const view = (row: { email: string; trialEndsAt: string | null; proEndsAt: string | null }) => {
  const trial = toDate(row.trialEndsAt);
  const pro = toDate(row.proEndsAt);
  return {
    email: row.email,
    tier: tierFor(trial, pro),
    trialEndsAt: row.trialEndsAt,
    proEndsAt: row.proEndsAt,
  };
};

export const GET = async (req: NextRequest) => {
  if (!(await owner())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (dbBackend() !== "d1") return NextResponse.json({ error: "D1 only" }, { status: 501 });
  const email = req.nextUrl.searchParams.get("email")?.trim() ?? "";
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const row = await new MembershipD1Repo(getD1()).getUserByEmail(email);
  if (!row) return NextResponse.json({ error: "No account with that email" }, { status: 404 });
  return NextResponse.json(view(row));
};

export const POST = async (req: NextRequest) => {
  const by = await owner();
  if (!by) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (dbBackend() !== "d1") return NextResponse.json({ error: "D1 only" }, { status: 501 });
  const body = (await req.json().catch(() => ({}))) as { email?: string; days?: number };
  const email = body.email?.trim() ?? "";
  const days = Math.floor(Number(body.days));
  if (!email || !Number.isFinite(days) || days < 1 || days > MAX_DAYS)
    return NextResponse.json({ error: `email and 1–${MAX_DAYS} days required` }, { status: 400 });
  const repo = new MembershipD1Repo(getD1());
  const row = await repo.getUserByEmail(email);
  if (!row)
    return NextResponse.json(
      { error: "No account with that email — they must sign in once first" },
      { status: 404 },
    );
  const until = extendPro(toDate(row.proEndsAt), days);
  await repo.setPro(row.id, until);
  console.log(
    JSON.stringify({
      msg: "dev.membership.grant",
      to: row.email,
      days,
      until: until.toISOString(),
      by: by.email,
    }),
  );
  return NextResponse.json(view({ ...row, proEndsAt: until.toISOString() }));
};
