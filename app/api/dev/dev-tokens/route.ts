import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { DevAccessError, listTokens, mintToken, revokeAll } from "@/lib/dev-access";
import type { DevAccessDb } from "@/lib/dev-access";

/**
 * The owner's dev access tokens (lib/dev-access.ts, docs/dev-whole-page.md):
 * GET lists them, POST {name, days} mints one and answers it ONCE,
 * POST {revokeAll: true} ends every token and dev-server session.
 * Owner session only; 404 for anyone else, as every /api/dev route.
 */
const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const db = () => getD1() as unknown as DevAccessDb;

async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) && user?.id ? { id: user.id, email: user.email } : null;
}

export const GET = async () => {
  const who = await owner();
  if (!who || dbBackend() !== "d1") return notFound();
  return NextResponse.json({ tokens: await listTokens(db(), who.id) }, { headers: NO_STORE });
};

export const POST = async (req: Request) => {
  const who = await owner();
  if (!who || dbBackend() !== "d1") return notFound();
  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    days?: unknown;
    revokeAll?: unknown;
  };
  if (body.revokeAll === true) {
    await revokeAll(db(), who.id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }
  try {
    const t = await mintToken(db(), who, String(body.name ?? ""), Number(body.days));
    console.log(JSON.stringify({ event: "dev-token.minted", id: t.id })); // never the token
    return NextResponse.json(t, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof DevAccessError)
      return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    throw e;
  }
};
