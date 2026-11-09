/**
 * Login notification: a sign-in from a browser this account has not used
 * before sends the account an email — when, roughly where (Cloudflare's IP
 * geolocation), and the user agent. 不正ログイン対策 ⑤ in the PAY.JP security
 * declaration; docs/security-measures.md.
 *
 * A browser is recognised by `lk_device`, a random httpOnly cookie. Only its
 * SHA-256 is stored (`known_device`), so the table cannot be used to forge
 * one. The sign-up itself is not announced: the account was made by that
 * browser a moment ago.
 */
import { renderBuiltin } from "@/lib/mail-templates/compose";
import { MAIL_CONTACT_URL, loginNoticeCopy } from "@/lib/mail-templates/defs";
import type { MailLocale } from "@/lib/mail-templates/locales";
import { sha256Hex, type ThrottleDb } from "./throttle";

export const DEVICE_COOKIE = "lk_device";
/**
 * 400 days, the most a browser keeps a cookie (RFC 6265bis; better-auth refuses
 * more). Renewed at every sign-in, so a browser in use stays known.
 */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
/** An account this young is still its own sign-up; no notice. */
export const SIGN_UP_GRACE_MS = 10 * 60 * 1000;

export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cookie value we issued: 48 hex characters. Anything else is a new device. */
export function validDeviceId(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[0-9a-f]{48}$/.test(v);
}

export interface SignInRecord {
  /** The value to (re)set in `lk_device`. */
  deviceId: string;
  /** True when this sign-in should be announced by mail. */
  notify: boolean;
  newDevice: boolean;
}

/**
 * Note a sign-in: known browser → touch `lastSeen`; unknown → remember it and
 * ask for a notice unless the account was created just now.
 */
export async function recordSignIn(
  db: ThrottleDb,
  input: {
    userId: string;
    userCreatedAt: Date | string | null | undefined;
    deviceCookie: string | null | undefined;
    userAgent: string | null | undefined;
    now?: Date;
  },
): Promise<SignInRecord> {
  const now = input.now ?? new Date();
  const deviceId = validDeviceId(input.deviceCookie) ? input.deviceCookie : newDeviceId();
  const deviceHash = await sha256Hex(deviceId);
  const ua = (input.userAgent ?? "").slice(0, 400) || null;

  const known = await db
    .prepare("SELECT 1 AS k FROM known_device WHERE userId = ?1 AND deviceHash = ?2")
    .bind(input.userId, deviceHash)
    .first<{ k: number }>();
  if (known) {
    await db
      .prepare(
        "UPDATE known_device SET lastSeen = ?3, userAgent = ?4 WHERE userId = ?1 AND deviceHash = ?2",
      )
      .bind(input.userId, deviceHash, now.toISOString(), ua)
      .run();
    return { deviceId, notify: false, newDevice: false };
  }

  await db
    .prepare(
      `INSERT INTO known_device (userId, deviceHash, userAgent, firstSeen, lastSeen)
       VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(userId, deviceHash) DO NOTHING`,
    )
    .bind(input.userId, deviceHash, ua, now.toISOString())
    .run();

  const created = input.userCreatedAt ? new Date(input.userCreatedAt).getTime() : NaN;
  const isSignUp = Number.isFinite(created) && now.getTime() - created < SIGN_UP_GRACE_MS;
  return { deviceId, notify: !isSignUp, newDevice: true };
}

/** "Tokyo, 13, JP" from Cloudflare's request.cf, or its visitor-location headers. */
export function approximateLocation(
  cf: { city?: unknown; region?: unknown; country?: unknown } | null | undefined,
  headers?: Headers | null,
): string {
  const parts = [
    cf?.city ?? headers?.get("cf-ipcity"),
    cf?.region ?? headers?.get("cf-region"),
    cf?.country ?? headers?.get("cf-ipcountry"),
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p && p !== "XX" && p !== "T1");
  return parts.join(", ");
}

/** `2026-10-30 14:05 UTC` — unambiguous in every locale. */
export function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The notice's values for template `login-notice` (lib/mail-templates/defs.ts):
 * time in UTC, the location or the locale's word for "unknown", the browser,
 * and the contact link.
 */
export function loginNoticeValues(
  locale: MailLocale,
  info: { when: Date; location: string; userAgent: string | null | undefined },
): Record<string, string> {
  const c = loginNoticeCopy(locale);
  return {
    time: utcStamp(info.when),
    location: info.location || c.unknown,
    browser: (info.userAgent ?? "").slice(0, 400) || c.unknown,
    contactUrl: MAIL_CONTACT_URL,
  };
}

/** The built-in notice (no stored edit), for tests and previews. */
export function loginNoticeMail(
  locale: MailLocale,
  info: { when: Date; location: string; userAgent: string | null | undefined },
): { subject: string; text: string; html: string } {
  const { subject, text, html } = renderBuiltin(
    "login-notice",
    locale,
    loginNoticeValues(locale, info),
  );
  return { subject, text, html };
}
