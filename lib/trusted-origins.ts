/**
 * better-auth trusted origins.
 *
 * The deployed origins are fixed. The only dynamic entry is a **localhost** QA
 * origin, and it exists for a specific reason: `qa:all` boots `wrangler dev` on
 * `QA_PORT` and sets `BETTER_AUTH_BASE_URL` to match, but the allowlist was
 * hardcoded to `http://localhost:3000`, so any other port had every write
 * rejected as an untrusted origin. That pinned QA to one port, which meant two
 * agents on the same host could not gate a push at the same time — one run's
 * `wrangler dev` stole the port from the other, and the failures looked like
 * flaky suites rather than contention.
 *
 * Only a localhost URL is ever honoured, so this can never widen the allowlist
 * on the deployed app even though `BETTER_AUTH_BASE_URL` is set there too.
 */

export const PRODUCTION_ORIGINS = [
  "https://lianki.com",
  "https://www.lianki.com",
  "http://localhost:3000",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The localhost origin implied by `baseUrl`, or nothing if it is not local. */
export function localQaOrigin(baseUrl: string | undefined | null): string[] {
  const raw = baseUrl?.trim();
  if (!raw) return [];
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [];
    return LOCAL_HOSTS.has(u.hostname) ? [u.origin] : [];
  } catch {
    return [];
  }
}

/** Deployed origins plus the QA one, de-duplicated and order-stable. */
export function trustedOrigins(baseUrl = process.env.BETTER_AUTH_BASE_URL): string[] {
  return [...new Set([...PRODUCTION_ORIGINS, ...localQaOrigin(baseUrl)])];
}
