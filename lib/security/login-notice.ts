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
import { isTimeZone, zonedDateTime } from "@/lib/dates";
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

/**
 * "Tokyo, Japan" from Cloudflare's request.cf, or its visitor-location
 * headers. The country is named in the reader's language when `locale` is
 * given (日本, Japan); a region that repeats the city or is only a code (13)
 * is left out.
 */
export function approximateLocation(
  cf: { city?: unknown; region?: unknown; country?: unknown } | null | undefined,
  headers?: Headers | null,
  locale?: string,
): string {
  const clean = (p: unknown) => (typeof p === "string" ? p.trim() : "");
  const city = clean(cf?.city ?? headers?.get("cf-ipcity"));
  let region = clean(cf?.region ?? headers?.get("cf-region"));
  let country = clean(cf?.country ?? headers?.get("cf-ipcountry"));
  if (country === "XX" || country === "T1") country = "";
  if (region === city || /^[0-9]+$/.test(region)) region = "";
  if (locale && /^[A-Z]{2}$/.test(country)) {
    try {
      const loc = locale === "zh-Hant" ? "zh-TW" : locale;
      country = new Intl.DisplayNames([loc], { type: "region" }).of(country) ?? country;
    } catch {}
  }
  return [city, region, country].filter(Boolean).join(", ");
}

/** `2026-10-30 14:05 UTC`: kept for logs; the mail itself says local time (zonedDateTime). */
export function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * "Safari · iPhone" from a user-agent string: the browser and the device or
 * system, which a reader recognises. The raw string when neither is known.
 */
export function describeBrowser(ua: string | null | undefined): string {
  const s = (ua ?? "").slice(0, 400);
  if (!s) return "";
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser\//.test(s)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(s)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(s)
            ? "Chrome"
            : /Safari\//.test(s) && /Version\/|iPhone|iPad|Macintosh/.test(s)
              ? "Safari"
              : "";
  const device = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /CrOS/.test(s)
          ? "ChromeOS"
          : /Windows/.test(s)
            ? "Windows"
            : /Mac OS X|Macintosh/.test(s)
              ? "macOS"
              : /Linux/.test(s)
                ? "Linux"
                : "";
  if (!browser && !device) return s.slice(0, 200);
  return [browser, device].filter(Boolean).join(" · ");
}

/**
 * The notice's values for template `login-notice` (lib/mail-templates/defs.ts).
 * Time: the reader's local time, labelled with its zone (lib/dates.ts) — the
 * account's own zone when it has one, else the zone captured with this
 * sign-in (Cloudflare's request.cf.timezone), else UTC, labelled "UTC".
 * Location in the reader's language, the browser as "Safari · iPhone", or
 * the locale's word for "unknown"; the contact link.
 */
export function loginNoticeValues(
  locale: MailLocale,
  info: {
    when: Date;
    location: string;
    userAgent: string | null | undefined;
    /** The account's time zone (IANA), when it has one. */
    accountTimeZone?: string | null;
    /** The time zone captured with this sign-in (request.cf.timezone). */
    eventTimeZone?: string | null;
  },
): Record<string, string> {
  const c = loginNoticeCopy(locale);
  const tz = isTimeZone(info.accountTimeZone)
    ? info.accountTimeZone
    : isTimeZone(info.eventTimeZone)
      ? info.eventTimeZone
      : null;
  return {
    time: zonedDateTime(info.when, locale, tz),
    location: info.location || c.unknown,
    browser: describeBrowser(info.userAgent) || c.unknown,
    contactUrl: MAIL_CONTACT_URL,
  };
}

/** The built-in notice (no stored edit), for tests and previews. */
export function loginNoticeMail(
  locale: MailLocale,
  info: Parameters<typeof loginNoticeValues>[1],
): { subject: string; text: string; html: string } {
  const { subject, text, html } = renderBuiltin(
    "login-notice",
    locale,
    loginNoticeValues(locale, info),
  );
  return { subject, text, html };
}
