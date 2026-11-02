/**
 * The dev bridge (owner decision, 2026-10-31): the owner's whole-page dev
 * server (docs/dev-whole-page.md) signs its sessions with a local secret, so
 * lianki.com cannot read them, and the debug chat hub (lianki-push) refused it.
 * Instead the dev server's guard sends a dedicated secret, DEV_BRIDGE_SECRET
 * (a Worker secret, nothing else uses it), and /api/debug/identity answers
 * with the OWNER — never another user — when it matches. AUTH_SECRET is never
 * shared.
 */

/** Same name as workers/push/src/auth.ts DEV_BRIDGE_HEADER. */
export const DEV_BRIDGE_HEADER = "x-lianki-dev-bridge";

/** At least this long, or the bridge stays shut. */
export const DEV_BRIDGE_MIN_LENGTH = 32;

/**
 * Does `sent` match the configured secret? An unset or short secret never
 * matches, so the bridge is shut until the owner sets one. Constant time.
 */
export function devBridgeMatches(sent: string | null, secret: string | undefined): boolean {
  if (!sent || !secret || secret.length < DEV_BRIDGE_MIN_LENGTH) return false;
  if (sent.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < sent.length; i++) diff |= sent.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
