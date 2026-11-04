// Shared gate for the /api/connections/google/* routes: a session, D1, and
// `connectionsOn` (the flag, or the owner). Anyone else gets a plain 404, so
// the feature is invisible while it ships dark.

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { connectionsOn } from "./gate";

export type ConnCtx = { userId: string; email: string | null; db: D1Like };

export const fail = (error: string, status: number, extra?: Record<string, string>) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store", ...extra } });

export async function connectionContext(): Promise<ConnCtx | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return fail("Unauthorized", 401);
  if (dbBackend() !== "d1") return fail("Not found", 404);
  const email = session.user.email ?? null;
  if (!connectionsOn(await readFlags(), isOwner(email))) return fail("Not found", 404);
  return { userId, email, db: getD1() as unknown as D1Like };
}
