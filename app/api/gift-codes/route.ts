import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { isOwner } from "@/lib/owner";
import { createGiftCode, listGiftCodes } from "@/lib/referrals/store";

/** Owner-only: anyone else gets a 404, so the endpoint's existence is not revealed. */
async function owner() {
  const session = await auth.api.getSession({ headers: await headers() });
  return isOwner(session?.user?.email) ? session!.user : null;
}

export async function GET() {
  if (!(await owner()) || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  return NextResponse.json({ codes: await listGiftCodes(getD1()) });
}

/** `{ days, maxUses, note?, expiresAt? }` → `{ code }`. */
export async function POST(req: Request) {
  const user = await owner();
  if (!user || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const days = Number(body?.days);
  const maxUses = Number(body?.maxUses);
  const expiresAt = body?.expiresAt ? new Date(String(body.expiresAt)) : undefined;
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3660 ||
    !Number.isInteger(maxUses) ||
    maxUses < 1 ||
    maxUses > 100000 ||
    (expiresAt && Number.isNaN(expiresAt.getTime()))
  ) {
    return NextResponse.json({ error: "Bad input" }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.slice(0, 200) : undefined;
  const code = await createGiftCode(getD1(), user.email, { days, maxUses, note, expiresAt });
  return NextResponse.json({ code });
}
