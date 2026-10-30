/**
 * Switches for the whole-page dev server (docs/dev-whole-page.md): `next dev`
 * on the owner's Mac against production D1, behind scripts/dev/whole-page.ts's
 * guard. Every switch is off unless that launcher set all of its env, and the
 * launcher only runs `next dev`, so none of this can turn on in production.
 */

/** The guard → login-route header. Same name as scripts/dev/whole-page-guard.ts GUARD_HEADER. */
export const DEV_GUARD_HEADER = "x-lianki-dev-guard";

type Env = Record<string, string | undefined>;

/** The launcher is running this process. */
export function devWholePage(env: Env = process.env): boolean {
  return env.LIANKI_DEV_WHOLE_PAGE === "1" && env.NODE_ENV === "development";
}

/** The guard's secret is set, long enough, and this request carries it. */
export function devWholePageLoginAllowed(env: Env, headers: Headers): boolean {
  const secret = env.LIANKI_DEV_GUARD_SECRET ?? "";
  if (!devWholePage(env) || secret.length < 32) return false;
  const sent = headers.get(DEV_GUARD_HEADER) ?? "";
  if (sent.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < sent.length; i++) diff |= sent.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/**
 * The dev server's own origin, for better-auth's trusted origins: only while
 * the launcher runs, and only a private-LAN http(s) origin or the owner's
 * tailnet HTTPS front (`https://<mac>.ts.net:<port>`, via `tailscale serve`,
 * which is tailnet-only: plain http is not a secure context, so
 * crypto.randomUUID, service workers and the mic are missing there).
 */
export function devWholePageOrigin(env: Env = process.env): string[] {
  if (!devWholePage(env)) return [];
  try {
    const u = new URL(env.BETTER_AUTH_BASE_URL ?? "");
    if (u.protocol === "https:" && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(u.hostname))
      return [u.origin];
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(u.hostname);
    if (!m || !/^https?:$/.test(u.protocol)) return [];
    const [a, b] = [Number(m[1]), Number(m[2])];
    const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    return lan ? [u.origin] : [];
  } catch {
    return [];
  }
}
