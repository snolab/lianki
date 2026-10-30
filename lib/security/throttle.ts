/**
 * Counters in D1 for the security limits (docs/security-measures.md):
 *
 * - failed sign-ins, per account and per IP — 10 within 15 minutes locks that
 *   key for 30 minutes (PCI DSS v4.0 8.3.4: at most 10 attempts, at least 30
 *   minutes or until the identity is confirmed);
 * - sign-in code sends, per address and per IP;
 * - checkout starts, per user and per IP (card-testing protection).
 *
 * D1, not memory: a Worker isolate's memory is per isolate and per region, so
 * an in-memory counter (lib/rateLimit.ts) can be walked around by spreading
 * attempts. Each check is one upsert with RETURNING, so concurrent requests
 * cannot both read the old count.
 */

/** The subset of D1 the counters use; `TestD1Database` provides it in tests. */
export interface ThrottleDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export interface Limit {
  /** Hits allowed inside one window. */
  max: number;
  windowMs: number;
  /** For failure counters: how long the key stays locked once `max` is reached. */
  lockMs?: number;
}

const MIN = 60_000;

/** Failed sign-ins — wrong code, rejected passkey — per account or IP. */
export const SIGN_IN_FAILURES: Limit = { max: 10, windowMs: 15 * MIN, lockMs: 30 * MIN };
/** Sign-in code / link mails to one address. */
export const CODE_SENDS_PER_ACCOUNT: Limit = { max: 5, windowMs: 15 * MIN };
/** Sign-in code / link mails from one IP. */
export const CODE_SENDS_PER_IP: Limit = { max: 20, windowMs: 15 * MIN };
/** Checkout starts per user and per IP. */
export const CHECKOUT_STARTS: Limit = { max: 5, windowMs: 10 * MIN };

export interface HitResult {
  allowed: boolean;
  count: number;
  /** ms until the key accepts again (0 when allowed). */
  retryAfterMs: number;
}

/**
 * Count one hit on `key`. Allowed while the window's count is ≤ `max`; a
 * counter with `lockMs` locks the key when it reaches `max`.
 */
export async function hit(
  db: ThrottleDb,
  key: string,
  limit: Limit,
  now = Date.now(),
): Promise<HitResult> {
  const expired = now - limit.windowMs;
  const row = await db
    .prepare(
      `INSERT INTO auth_throttle (key, count, windowStart, lockedUntil) VALUES (?1, 1, ?2, 0)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN windowStart <= ?3 THEN 1 ELSE count + 1 END,
         windowStart = CASE WHEN windowStart <= ?3 THEN ?2 ELSE windowStart END
       RETURNING count, windowStart, lockedUntil`,
    )
    .bind(key, now, expired)
    .first<{ count: number; windowStart: number; lockedUntil: number }>();
  const count = row?.count ?? 1;
  const windowStart = row?.windowStart ?? now;
  let lockedUntil = row?.lockedUntil ?? 0;

  if (limit.lockMs) {
    // A failure counter: the hit is a failure that already happened. Reaching
    // `max` locks the key; the next attempt is refused by `lockedFor`.
    if (count >= limit.max && lockedUntil <= now) {
      lockedUntil = now + limit.lockMs;
      await db
        .prepare("UPDATE auth_throttle SET lockedUntil = ?2 WHERE key = ?1")
        .bind(key, lockedUntil)
        .run();
    }
    const locked = lockedUntil > now;
    return { allowed: !locked, count, retryAfterMs: locked ? lockedUntil - now : 0 };
  }
  const allowed = count <= limit.max;
  return { allowed, count, retryAfterMs: allowed ? 0 : windowStart + limit.windowMs - now };
}

/** Is `key` locked right now? (Checked before an attempt is even tried.) */
export async function lockedFor(db: ThrottleDb, key: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare("SELECT lockedUntil FROM auth_throttle WHERE key = ?1")
    .bind(key)
    .first<{ lockedUntil: number }>();
  const until = row?.lockedUntil ?? 0;
  return until > now ? until - now : 0;
}

/** Forget a key — a successful sign-in clears that account's failures. */
export async function reset(db: ThrottleDb, key: string): Promise<void> {
  await db.prepare("DELETE FROM auth_throttle WHERE key = ?1").bind(key).run();
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The counter key for an account: a hash, so the table never holds an address. */
export async function accountKey(kind: string, email: string): Promise<string> {
  return `${kind}:acct:${await sha256Hex(email.trim().toLowerCase())}`;
}

export const ipKey = (kind: string, ip: string) => `${kind}:ip:${ip}`;

/**
 * The client IP as Cloudflare saw it. `cf-connecting-ip` is set by Cloudflare
 * at the edge and cannot be supplied by the client through it; the fallbacks
 * only matter for local dev.
 */
export function clientIp(headers: Headers | undefined | null): string {
  if (!headers) return "unknown";
  return (
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
