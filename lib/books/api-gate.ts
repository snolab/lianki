// The /api/books/* gate, shared by import, resolve and search: a session, D1,
// and `library.catalogue` (or the `dev` permission); plus a per-user D1 rate limit.

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { hit } from "@/lib/security/throttle";
import { libraryOn } from "./gate";

export const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/** The signed-in user allowed to use /books, or the response refusing them. */
export async function booksApiUser(): Promise<{ userId: string } | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return fail("Unauthorized", 401);
  if (dbBackend() !== "d1") return fail("Not found", 404);
  if (!libraryOn(await readFlags(), isDev(session.user.email ?? null)))
    return fail("Not found", 404);
  return { userId };
}

/** Count one use of `what` for this user; the 429 response when over the limit. */
export async function booksRate(
  what: string,
  userId: string,
  limit: { windowMs: number; max: number },
): Promise<NextResponse | null> {
  const r = await hit(getD1(), `books-${what}:${userId}`, limit);
  if (r.allowed) return null;
  return NextResponse.json(
    { error: "rate-limited" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(r.retryAfterMs / 1000)) } },
  );
}
