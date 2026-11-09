import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { checkRateLimit } from "@/lib/rateLimit";
import { clientIp, hit, type ThrottleDb } from "@/lib/security/throttle";
import { dohResolver } from "@/lib/byok/proxy-guard";
import { handleProxy, type RateHit } from "@/lib/byok/proxy-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/byok/proxy — Lianki's relay for the user's own AI key
 * (docs/byok.md "The relay"): forwards one call to an ALLOWLISTED provider
 * (lib/byok/presets.ts `relay`) and forgets the key and the text. A free account
 * is needed; calling the provider straight from the browser needs none. Every
 * guard is in lib/byok/proxy-server.ts and lib/byok/proxy-guard.ts.
 */
const resolve = dohResolver();

export async function POST(req: Request) {
  // The session from the cookie alone: the Authorization header carries the
  // provider key and must never reach session lookup.
  const cookie = req.headers.get("cookie");
  const session = cookie
    ? await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null)
    : null;
  const d1 = dbBackend() === "d1" ? (getD1() as unknown as ThrottleDb) : null;
  const rate: RateHit = d1
    ? (key, limit) => hit(d1, key, limit)
    : async (key, limit) => checkRateLimit(key, limit);
  return handleProxy(req, {
    fetch: (url, init) => fetch(url, init),
    resolve,
    hit: rate,
    ip: clientIp(req.headers),
    userId: session?.user?.id ?? null,
  });
}
