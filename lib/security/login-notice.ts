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
import type { MailLocale } from "@/lib/sign-in-mail";
import { sha256Hex, type ThrottleDb } from "./throttle";

export const DEVICE_COOKIE = "lk_device";
/** Two years: the cookie only has to outlive the habit of signing in. */
export const DEVICE_COOKIE_MAX_AGE_S = 2 * 365 * 24 * 60 * 60;
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const COPY = {
  en: {
    subject: "New sign-in to your Lianki account",
    intro: "Your Lianki account was just signed in to from a browser it has not used before.",
    time: "Time",
    location: "Approximate location",
    unknown: "unknown",
    device: "Browser",
    ok: "If this was you, there is nothing to do.",
    notYou:
      "If it was not you, sign in, remove any passkey you do not recognise on your profile page, and tell us at https://lianki.com/contact.",
  },
  zh: {
    subject: "你的炼記账号有新的登录",
    intro: "你的炼記（Lianki）账号刚刚在一个以前未使用过的浏览器上登录。",
    time: "时间",
    location: "大致位置",
    unknown: "未知",
    device: "浏览器",
    ok: "如果是你本人操作，无需处理。",
    notYou:
      "如果不是你本人，请登录后在个人资料页删除不认识的通行密钥，并通过 https://lianki.com/contact 联系我们。",
  },
} as const;

export function loginNoticeMail(
  locale: MailLocale,
  info: { when: Date; location: string; userAgent: string | null | undefined },
): { subject: string; text: string; html: string } {
  const c = COPY[locale];
  const rows: [string, string][] = [
    [c.time, utcStamp(info.when)],
    [c.location, info.location || c.unknown],
    [c.device, (info.userAgent ?? "").slice(0, 400) || c.unknown],
  ];
  return {
    subject: c.subject,
    text: [c.intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", c.ok, c.notYou].join("\n"),
    html:
      `<p>${esc(c.intro)}</p>` +
      `<table>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join("")}</table>` +
      `<p>${esc(c.ok)}<br>${esc(c.notYou)}</p>`,
  };
}
