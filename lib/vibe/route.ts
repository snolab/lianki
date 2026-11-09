// The gate every /api/vibe route goes through (docs/vibe.md; the answers are
// lib/vibe/api.ts). Text in, never logged.
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import type { D1Batch } from "@/lib/read/reader-store";
import { CREDITS_HEADER, CREDITS_NEEDED, CREDITS_PAUSED } from "@/lib/payments/no-credits-watch";
import { readJsonCapped } from "@/lib/security/route-guard";
import { sameOriginJson } from "@/lib/security/same-origin";
import { NOT_FOUND, vibeUserId, type Reply } from "./api";

export const reply = (r: Reply) =>
  NextResponse.json(r.body, {
    status: r.status,
    headers: {
      "cache-control": "no-store",
      // A credit refusal (lib/payments/metered.ts): the page's notice hears it.
      ...(r.body.error === "no-credits" ? { [CREDITS_HEADER]: CREDITS_NEEDED } : {}),
      ...(r.body.error === "credits-paused" ? { [CREDITS_HEADER]: CREDITS_PAUSED } : {}),
    },
  });

/** The signed-in owner while `read.vibe` is on; null for everyone and everything else. */
export async function vibeGate(): Promise<{
  userId: string;
  email: string | null;
  db: D1Batch;
} | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const id = session?.user?.id;
  const who = id ? { userId: id, owner: isDev(session.user.email ?? null) } : null;
  const userId = vibeUserId(who, who ? await readFlags() : null, dbBackend());
  return userId
    ? { userId, email: session?.user?.email ?? null, db: getD1() as unknown as D1Batch }
    : null;
}

/** A write: the gate, then a same-origin JSON body under `maxBytes`. */
export async function vibeWrite(
  req: Request,
  maxBytes: number,
  run: (g: { userId: string; email: string | null; db: D1Batch }, body: unknown) => Promise<Reply>,
): Promise<NextResponse> {
  const g = await vibeGate();
  if (!g) return reply(NOT_FOUND);
  if (!sameOriginJson(req)) return reply({ status: 403, body: { error: "Forbidden" } });
  const body = await readJsonCapped(req, maxBytes);
  if (!body.ok) return reply({ status: body.status, body: { error: "bad-body" } });
  return reply(await run(g, body.value));
}
