/**
 * Small guards for API routes (docs/security-measures.md, "Route limits"):
 *
 * - `routeLimit` / `tooMany`: a per-key request limit counted in D1
 *   (`auth_throttle`, lib/security/throttle.ts `hit`), so it holds across
 *   Worker isolates and regions. Without D1 (local Mongo dev) it falls back to
 *   the per-isolate memory counter (lib/rateLimit.ts).
 * - `readJsonCapped`: a JSON body read as a stream and cut off at a byte cap,
 *   so a huge body is refused before it is buffered or parsed.
 * - `offSiteWritingGet`: a request from another site or a sibling host that
 *   would carry the SameSite=Lax session cookie. A GET that changes data refuses
 *   it (CSRF), while same-origin fetches, the userscript and API tokens are
 *   unaffected. Writes other than GET: lib/security/same-site-guard.ts.
 */
import { NextResponse } from "next/server";
import { dbBackend, getD1 } from "@/lib/d1";
import { checkRateLimit } from "@/lib/rateLimit";
import { hit, type Limit, type ThrottleDb } from "./throttle";

export type LimitResult = { allowed: boolean; retryAfterMs: number };

/** D1 when this deploy runs on it, else null (the memory fallback). */
function defaultDb(): ThrottleDb | null {
  return dbBackend() === "d1" ? (getD1() as unknown as ThrottleDb) : null;
}

/** Count one hit on `key`; D1-backed when available. */
export async function routeLimit(
  key: string,
  limit: Limit,
  db: ThrottleDb | null = defaultDb(),
): Promise<LimitResult> {
  if (db) {
    const r = await hit(db, key, { max: limit.max, windowMs: limit.windowMs });
    return { allowed: r.allowed, retryAfterMs: r.retryAfterMs };
  }
  const r = checkRateLimit(key, limit);
  return { allowed: r.allowed, retryAfterMs: r.retryAfterMs };
}

/** The 429 for a refused limit (with Retry-After), or null when allowed. */
export async function tooMany(
  key: string,
  limit: Limit,
  db?: ThrottleDb | null,
): Promise<NextResponse | null> {
  const r = await routeLimit(key, limit, db === undefined ? defaultDb() : db);
  if (r.allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please retry later." },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
    },
  );
}

export type CappedJson = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/**
 * The body parsed as JSON, read with a byte cap: 413 when Content-Length or
 * the stream passes `max`, 400 when it is not JSON.
 */
export async function readJsonCapped(req: Request, max: number): Promise<CappedJson> {
  const len = req.headers.get("content-length");
  if (len !== null && !(Number(len) <= max)) return { ok: false, status: 413 };
  if (!req.body) return { ok: false, status: 400 };
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      try {
        await reader.cancel();
      } catch {}
      return { ok: false, status: 413 };
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(all)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** The JSON error for a failed `readJsonCapped`. */
export function cappedJsonError(status: 400 | 413): NextResponse {
  return NextResponse.json(
    { error: status === 413 ? "Request body too large" : "Invalid JSON body" },
    { status },
  );
}

/**
 * A GET that writes must not come from elsewhere. Two ways carry the SameSite=Lax
 * session cookie: a top-level navigation another site started (a link, a form
 * GET, a redirect), and anything at all from a sibling *.lianki.com host, which
 * a browser counts as the same site. Browsers without Fetch Metadata send
 * neither header and pass.
 */
export function offSiteWritingGet(req: Request): boolean {
  return offSiteHeaders(req.headers);
}

/** The same rule, for a route that has only `next/headers`. */
export function offSiteHeaders(h: Headers): boolean {
  const site = h.get("sec-fetch-site")?.toLowerCase();
  const mode = h.get("sec-fetch-mode")?.toLowerCase();
  return site === "same-site" || (site === "cross-site" && mode === "navigate");
}

/** The client's own address, for a per-IP limit (Cloudflare's header first). */
export { clientIp } from "./throttle";
