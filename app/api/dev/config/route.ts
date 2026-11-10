import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { dbBackend, getD1 } from "@/lib/d1";
import { CONFIG_CACHE_MS, changeConfig, configLog, listConfig } from "@/lib/config-store";
import type { D1WithBatch } from "@/lib/flags-store";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * The config editor's API (admin only, 404 for anyone else; under /api/dev/ so
 * Cloudflare Access covers it). docs/config-store.md.
 * - GET → every registry key with its value, default and stored state, and the
 *   newest 100 changes;
 * - POST `{ key, value, note? }` sets a value, `{ key, reset: true, note? }`
 *   goes back to the default (same-origin JSON only); a `money` key also needs
 *   `confirmMoney: true`. Unknown keys and invalid values are refused (400).
 * A change reaches every request within CONFIG_CACHE_MS (30 s), no deploy.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });

async function admin() {
  const user = await authUserOrNull();
  return isAdmin(user?.email) && user?.email ? user : null;
}

async function state() {
  const d1 = getD1();
  return {
    rows: await listConfig(d1),
    log: await configLog(d1, 100),
    cacheSeconds: CONFIG_CACHE_MS / 1000,
  };
}

export const GET = async () => {
  if (!(await admin()) || dbBackend() !== "d1") return notFound();
  return NextResponse.json(await state(), { headers: NO_STORE });
};

export const POST = async (req: Request) => {
  const by = await admin();
  if (!by || dbBackend() !== "d1") return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "Same-origin JSON only" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const r = await changeConfig(getD1() as unknown as D1WithBatch, body, by.email!);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE });
  return NextResponse.json(await state(), { headers: NO_STORE });
};
