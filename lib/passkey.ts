/**
 * Passkey (WebAuthn) settings and helpers shared by auth.ts and the UI.
 *
 * The relying party has to match the page the browser is on, exactly: a passkey
 * made for `lianki.com` can never be used on `localhost:58123`, and the server
 * must check the same origin the browser signed. Without a base URL (it is set
 * in wrangler.jsonc today, but was not always) the plugin's own fallback is
 * `localhost` — which would make every production ceremony fail. So the RP is
 * decided here, from the base URL when there is one:
 *
 *   - a localhost base URL (qa:all's `wrangler dev` on a random port, `next dev`)
 *     → that host and that exact origin;
 *   - any other base URL → its host with `www.` dropped, so a passkey made on the
 *     apex also works if `www` ever serves pages again;
 *   - none at all → `lianki.com` in production, `localhost` elsewhere.
 */

export const PASSKEY_RP_NAME = "Lianki";
export const PRODUCTION_RP_ID = "lianki.com";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type PasskeyRelyingParty = {
  rpID: string;
  /** Origins a ceremony may come from; `null` lets the plugin use the request's Origin header. */
  origin: string[] | null;
};

export function passkeyRelyingParty(
  baseUrl: string | undefined | null,
  production: boolean,
): PasskeyRelyingParty {
  const raw = baseUrl?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") {
        if (LOCAL_HOSTS.has(u.hostname)) return { rpID: u.hostname, origin: [u.origin] };
        const rpID = u.hostname.replace(/^www\./, "");
        return { rpID, origin: [`https://${rpID}`, `https://www.${rpID}`] };
      }
    } catch {
      // fall through to the defaults
    }
  }
  if (production)
    return {
      rpID: PRODUCTION_RP_ID,
      origin: [`https://${PRODUCTION_RP_ID}`, `https://www.${PRODUCTION_RP_ID}`],
    };
  return { rpID: "localhost", origin: null };
}

/**
 * A readable default name for a new passkey, e.g. "Chrome on macOS", so the
 * list on the profile page says which device each one is without asking.
 */
export function defaultPasskeyName(userAgent: string | undefined | null): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPod/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Passkey";
}

/** localStorage key: the after-sign-in passkey suggestion was dismissed on this device. */
export const PASSKEY_SUGGESTION_DISMISSED_KEY = "lianki:passkey-suggestion-dismissed";

/** Map a better-auth passkey error to which message the UI should show. */
export function passkeyErrorKind(
  error: { code?: string; status?: number } | null | undefined,
): "cancelled" | "duplicate" | "stale-session" | "failed" {
  const code = error?.code ?? "";
  if (code === "ERROR_CEREMONY_ABORTED" || code === "AUTH_CANCELLED") return "cancelled";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "duplicate";
  if (code === "SESSION_NOT_FRESH" || code === "UNAUTHORIZED") return "stale-session";
  return "failed";
}
