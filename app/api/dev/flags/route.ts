import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { FLAG_CACHE_MS, flagLog, listFlags, type D1WithBatch } from "@/lib/flags-store";
import { allFailedPrereqs, changeFlag, type PrereqContext } from "@/lib/flag-prereqs";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * Owner-only feature flags (404 for anyone else; under /api/dev/ so Cloudflare
 * Access covers it). docs/feature-flags.md.
 * - GET → every registry flag with its state, the prerequisites each one fails
 *   now (reason keys and texts only, never a setting's value), and the newest
 *   50 changes;
 * - POST `{ key, enabled }` (same-origin JSON only — lib/security/same-origin.ts)
 *   → turns one flag on or off and logs who and when. Unknown keys are refused;
 *   turning ON a flag whose prerequisites fail is refused (400, with the
 *   reasons); turning OFF always works.
 * A change reaches every request within FLAG_CACHE_MS (30 s), no deploy.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });

async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) && user?.email ? user : null;
}

const prereqContext = (): PrereqContext => ({
  env: process.env,
  d1: getD1() as unknown as D1Like,
});

async function state() {
  const d1 = getD1();
  return {
    flags: await listFlags(d1),
    prereqs: await allFailedPrereqs(prereqContext()),
    log: await flagLog(d1, 50),
    cacheSeconds: FLAG_CACHE_MS / 1000,
  };
}

export const GET = async () => {
  if (!(await owner()) || dbBackend() !== "d1") return notFound();
  return NextResponse.json(await state(), { headers: NO_STORE });
};

export const POST = async (req: Request) => {
  const by = await owner();
  if (!by || dbBackend() !== "d1") return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "Same-origin JSON only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { key?: unknown; enabled?: unknown };
  const r = await changeFlag(getD1() as unknown as D1WithBatch, body, by.email!, prereqContext());
  if (!r.ok)
    return NextResponse.json(
      { error: r.error, reasons: r.reasons },
      { status: 400, headers: NO_STORE },
    );
  return NextResponse.json(await state(), { headers: NO_STORE });
};
