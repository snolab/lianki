import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { isAdmin } from "@/lib/permissions";
import {
  applyPregrants,
  checkInput,
  listPending,
  previewPregrants,
  revokePregrant,
  type PregrantDb,
} from "@/lib/referrals/pregrant";

/**
 * Pre-grants (lib/referrals/pregrant.ts), the panel on /dev/users. Admin only;
 * anyone else gets a 404.
 *
 * - GET → `{ pending }`, the open grants.
 * - POST `{ action: "preview", text, days, note? }` → `{ rows }`; writes nothing.
 * - POST `{ action: "apply", text, days, note?, grantExpiresAt?, direct?, key }`
 *   → `{ created, granted, skipped, rows }`. The server previews again itself.
 * - DELETE `?id=` → revokes one open grant; 409 if claimed or already revoked.
 */
async function admin() {
  const session = await auth.api.getSession({ headers: await headers() });
  return isAdmin(session?.user?.email) ? session!.user : null;
}

const db = () => getD1() as unknown as PregrantDb;

export async function GET() {
  if (!(await admin()) || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  return NextResponse.json({ pending: await listPending(db()) });
}

export async function POST(req: Request) {
  const user = await admin();
  if (!user || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Bad input" }, { status: 400 });
  const input = {
    text: String(body.text ?? ""),
    days: Number(body.days),
    note: typeof body.note === "string" ? body.note : null,
    grantExpiresAt: typeof body.grantExpiresAt === "string" ? body.grantExpiresAt : null,
    direct: Array.isArray(body.direct) ? body.direct.map(String) : [],
    key: body.action === "apply" ? String(body.key ?? "") : undefined,
  };
  const error = checkInput(input, new Date());
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (body.action === "preview")
    return NextResponse.json({ rows: await previewPregrants(db(), input.text, input) });
  if (body.action === "apply")
    return NextResponse.json(
      await applyPregrants(db(), { id: user.id }, { ...input, key: input.key! }),
    );
  return NextResponse.json({ error: "Bad action" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const user = await admin();
  if (!user || dbBackend() !== "d1") return new NextResponse(null, { status: 404 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await revokePregrant(db(), { id: user.id }, id);
  return ok
    ? NextResponse.json({ revoked: id })
    : NextResponse.json({ error: "Not open" }, { status: 409 });
}
