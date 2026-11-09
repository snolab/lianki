/**
 * Invite by email (docs/payments.md, "Invite by email"). A Pro user — or an
 * admin — types one friend's address; Lianki mails that friend the inviter's
 * existing /i/CODE link, in the inviter's account language. Same code, same
 * rewards as a shared link (lib/referrals/rules.ts); nothing new to claim.
 *
 * Abuse controls, all here (limits in ./email-invite-config.ts):
 * - per inviter: EMAIL_INVITE.perInviterPerDay requests in 24 h, counted and
 *   claimed in ONE conditional insert, so parallel requests cannot pass it;
 * - per address: one invite mail in perRecipientDays from anyone, claimed with
 *   one conditional upsert on `invite_email_recipient`;
 * - one address per request, validated; an address that has an account, the
 *   inviter's own, a suppressed one, one mailed recently, or an inviter
 *   reported blockAfterReports times: no mail, and the SAME neutral "sent" —
 *   the inviter learns nothing about the address;
 * - every mail carries Unsubscribe / Report abuse (a page) and RFC 8058
 *   one-click headers; both write `invite_email_suppression`, checked before
 *   every send. Their token is an HMAC of the log row id, keyed from
 *   AUTH_SECRET (HKDF), so nobody can opt out an address they did not receive;
 * - no table holds the address: SHA-256 of its canonical form for matching,
 *   and a masked form for the inviter's own history. No log line holds either.
 */
import { canonicalEmail } from "@/lib/canonical-email";
import type { D1Like } from "@/lib/d1/types";
import type { SendEmailInput } from "@/lib/email";
import { flagIn, type FlagValues } from "@/lib/flags";
import { cleanEmail } from "@/lib/profile/email-change";
import { sameOriginJson } from "@/lib/security/same-origin";
import { clientIp, hit, ipKey, sha256Hex, type ThrottleDb } from "@/lib/security/throttle";
import {
  inviterMailLocale,
  mailTemplateLocale,
  type MailTemplateLocale,
} from "@/lib/signup-locale";
import { EMAIL_INVITE, RECIPIENT_WINDOW_MS } from "./email-invite-config";
import {
  optOutLinks,
  PREVIEW_RECIPIENT,
  renderInviteMail,
  type RenderedInviteMail,
} from "./invite-mail";
import { maskEmail } from "./rules";
import { getOrCreateInviteCode } from "./store";

export type InviteDb = D1Like & ThrottleDb;

export type EmailInviteDeps = {
  who: () => Promise<{ id: string; email: string } | null>;
  db: () => InviteDb;
  send: (mail: SendEmailInput) => Promise<{ id?: string } | unknown>;
  mailOn: () => boolean;
  /** AUTH_SECRET: the opt-out tokens' key is derived from it. */
  secret: () => string | undefined;
  flags: () => Promise<FlagValues>;
  isAdmin: (email: string) => boolean;
  /** Where links point: configured, never from the request's headers. */
  origin: () => string;
  now?: () => number;
};

export type LogStatus =
  | "pending"
  | "sent"
  | "skipped-recent"
  | "skipped-suppressed"
  | "skipped-account"
  | "skipped-blocked"
  | "failed";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const logEvent = (event: string) => console.error(JSON.stringify({ event }));

// ── Who may send ──────────────────────────────────────────────────────────────

/** Admins always; Pro users once the flag is on. Trial and free accounts never. */
export function canEmailInvite(p: { admin: boolean; pro: boolean; flags: FlagValues }): boolean {
  return p.admin || (p.pro && flagIn(p.flags, EMAIL_INVITE.flag));
}

type InviterRow = {
  name: string | null;
  email: string;
  proEndsAt: string | null;
  signupLocale: string | null;
};

async function inviterRow(db: InviteDb, id: string) {
  return db
    .prepare("SELECT name, email, proEndsAt, signupLocale FROM user WHERE id = ?1")
    .bind(id)
    .first<InviterRow>();
}

const isPro = (row: InviterRow | null, now: number) =>
  !!row?.proEndsAt && new Date(row.proEndsAt).getTime() > now;

/** The language the inviter set on their account (`ui.locale`, docs/prefs-sync.md), or null. */
async function accountLocale(db: InviteDb, id: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM user_prefs WHERE user_id = ?1 AND key = 'ui.locale'")
    .bind(id)
    .first<{ value: string }>()
    .catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as unknown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The inviter's mail language: account setting → signupLocale → en. */
export async function inviterLocale(db: InviteDb, id: string): Promise<MailTemplateLocale> {
  const [acct, row] = await Promise.all([accountLocale(db, id), inviterRow(db, id)]);
  return inviterMailLocale({ accountLocale: acct, signupLocale: row?.signupLocale });
}

async function gate(d: EmailInviteDeps, now: number) {
  const who = await d.who();
  if (!who) return { who: null, allowed: false, row: null } as const;
  const db = d.db();
  const row = await inviterRow(db, who.id);
  const allowed = canEmailInvite({
    admin: d.isAdmin(who.email),
    pro: isPro(row, now),
    flags: await d.flags(),
  });
  return { who, allowed, row } as const;
}

// ── Tokens ────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function optOutKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("invite-email: AUTH_SECRET missing or short");
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("lianki/invite-email"),
          info: enc.encode("lianki/invite-email/opt-out/v1"),
        },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    keys.set(secret, k);
  }
  return k;
}

const b64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** `<logId>.<HMAC(logId)>`: names one sent mail, and only its holder can make it. */
export async function signOptOut(secret: string | undefined, logId: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await optOutKey(secret), enc.encode(logId));
  return `${logId}.${b64url(sig)}`;
}

/** The log row id a token names, or null when it is not one of ours. */
export async function verifyOptOut(
  secret: string | undefined,
  token: unknown,
): Promise<string | null> {
  if (typeof token !== "string" || token.length > 200) return null;
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await optOutKey(secret),
      fromB64url(m[2]!),
      enc.encode(m[1]!),
    );
    return ok ? m[1]! : null;
  } catch {
    return null;
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────

/** Exactly one address, or null: a list, a name with <brackets>, or a bad form is refused. */
export function oneAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (/[\s,;<>"]/.test(t)) return null;
  const e = cleanEmail(t);
  if (!e || (e.match(/@/g) ?? []).length !== 1) return null;
  return e;
}

/** The recipient's matching key: SHA-256 of the canonical address. Never the address. */
export const recipientHash = (email: string) => sha256Hex(`invite-email:${canonicalEmail(email)}`);

/** Requests left in the inviter's 24 h window (failed sends are not counted). */
async function usedToday(db: InviteDb, inviterId: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM invite_email_log WHERE inviterId = ?1 AND createdAt > ?2 AND status != 'failed'",
    )
    .bind(inviterId, now - EMAIL_INVITE.inviterWindowMs)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Take one of today's slots and write the log row, in one statement; false when none is left. */
async function claimSlot(
  db: InviteDb,
  row: { id: string; inviterId: string; hash: string; masked: string; locale: string },
  now: number,
): Promise<boolean> {
  const got = await db
    .prepare(
      `INSERT INTO invite_email_log (id, inviterId, recipientHash, recipientMasked, locale, status, createdAt)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6
       WHERE (SELECT COUNT(*) FROM invite_email_log
              WHERE inviterId = ?2 AND createdAt > ?7 AND status != 'failed') < ?8
       RETURNING id`,
    )
    .bind(
      row.id,
      row.inviterId,
      row.hash,
      row.masked,
      row.locale,
      now,
      now - EMAIL_INVITE.inviterWindowMs,
      EMAIL_INVITE.perInviterPerDay,
    )
    .first<{ id: string }>();
  return !!got;
}

/** Claim the address's window; false when someone mailed it within perRecipientDays. */
async function claimRecipient(db: InviteDb, hash: string, now: number): Promise<boolean> {
  const got = await db
    .prepare(
      `INSERT INTO invite_email_recipient (recipientHash, lastSentAt) VALUES (?1, ?2)
       ON CONFLICT(recipientHash) DO UPDATE SET lastSentAt = ?2 WHERE lastSentAt <= ?3
       RETURNING lastSentAt`,
    )
    .bind(hash, now, now - RECIPIENT_WINDOW_MS)
    .first<{ lastSentAt: number }>();
  return !!got;
}

async function setStatus(db: InviteDb, id: string, status: LogStatus, providerId?: string) {
  await db
    .prepare("UPDATE invite_email_log SET status = ?2, providerId = ?3 WHERE id = ?1")
    .bind(id, status, providerId ?? null)
    .run();
}

/** Why this address gets no mail, or null to send. Every answer looks the same to the inviter. */
async function skipReason(
  db: InviteDb,
  inviterId: string,
  email: string,
  hash: string,
  now: number,
): Promise<LogStatus | null> {
  const reports = await db
    .prepare("SELECT COUNT(*) AS n FROM invite_email_log WHERE inviterId = ?1 AND reportedAt > ?2")
    .bind(inviterId, now - EMAIL_INVITE.reportWindowMs)
    .first<{ n: number }>();
  if (Number(reports?.n ?? 0) >= EMAIL_INVITE.blockAfterReports) return "skipped-blocked";
  // Any account, in its exact or canonical form — the inviter's own included.
  const account = await db
    .prepare("SELECT 1 AS hit FROM user WHERE lower(email) = ?1 OR email_canonical = ?2 LIMIT 1")
    .bind(email, canonicalEmail(email))
    .first();
  if (account) return "skipped-account";
  const suppressed = await db
    .prepare("SELECT 1 AS hit FROM invite_email_suppression WHERE recipientHash = ?1")
    .bind(hash)
    .first();
  if (suppressed) return "skipped-suppressed";
  if (!(await claimRecipient(db, hash, now))) return "skipped-recent";
  return null;
}

/**
 * Render the mail one inviter would send (real code, a real token when `logId`
 * is given). `to` is the recipient, rendered into the footer only; without it
 * (the preview) a placeholder address.
 */
export async function renderFor(
  d: Pick<EmailInviteDeps, "db" | "origin" | "secret">,
  inviterId: string,
  opts: { locale?: MailTemplateLocale; logId?: string; to?: string } = {},
): Promise<RenderedInviteMail & { locale: MailTemplateLocale }> {
  const db = d.db();
  const locale = opts.locale ?? (await inviterLocale(db, inviterId));
  const row = await inviterRow(db, inviterId);
  const code = await getOrCreateInviteCode(db, inviterId);
  const origin = d.origin();
  const token = opts.logId ? await signOptOut(d.secret(), opts.logId) : "preview";
  return {
    locale,
    ...renderInviteMail({
      locale,
      recipient: opts.to ?? PREVIEW_RECIPIENT,
      inviterName: row?.name,
      inviteUrl: `${origin}/i/${code}`,
      ...optOutLinks(origin, locale, token),
      oneClickUrl: `${origin}/api/invite/email/opt-out?t=${encodeURIComponent(token)}&lang=${locale}`,
    }),
  };
}

export type InviteEmailStatus =
  | { allowed: false }
  | {
      allowed: true;
      limit: number;
      remaining: number;
      recipientDays: number;
      history: { to: string; at: number }[];
    };

/** GET /api/invite/email — may this user send, how many left today, their own masked history. */
export async function emailInviteStatus(d: EmailInviteDeps): Promise<Response> {
  const now = (d.now ?? Date.now)();
  const g = await gate(d, now);
  if (!g.who) return json({ error: "unauthorized" }, 401);
  if (!g.allowed) return json({ allowed: false } satisfies InviteEmailStatus);
  const db = d.db();
  const used = await usedToday(db, g.who.id, now);
  const rows = await db
    .prepare(
      "SELECT recipientMasked AS m, createdAt AS at FROM invite_email_log WHERE inviterId = ?1 AND status != 'failed' ORDER BY createdAt DESC LIMIT ?2",
    )
    .bind(g.who.id, EMAIL_INVITE.historyRows)
    .all<{ m: string; at: number }>();
  return json({
    allowed: true,
    limit: EMAIL_INVITE.perInviterPerDay,
    remaining: Math.max(0, EMAIL_INVITE.perInviterPerDay - used),
    recipientDays: EMAIL_INVITE.perRecipientDays,
    history: rows.results.map((r) => ({ to: r.m, at: r.at })),
  } satisfies InviteEmailStatus);
}

/** POST /api/invite/email — {email, locale?}: invite one friend. */
export async function sendEmailInvite(req: Request, d: EmailInviteDeps): Promise<Response> {
  if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
  const now = (d.now ?? Date.now)();
  const g = await gate(d, now);
  if (!g.who) return json({ error: "unauthorized" }, 401);
  if (!g.allowed) return json({ error: "not-found" }, 404);
  const secret = d.secret();
  if (!d.mailOn() || !secret || secret.length < 32) return json({ error: "mail-off" }, 503);
  const text = await req.text().catch(() => "");
  if (text.length > 2048) return json({ error: "invalid" }, 400);
  type Body = { email?: unknown; locale?: unknown };
  let body: Body | null = null;
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  const email = oneAddress(body?.email);
  if (!email) return json({ error: "invalid" }, 400);
  const db = d.db();
  // The language: the API's override (no UI yet), else the inviter's own.
  const locale = mailTemplateLocale(body?.locale) ?? (await inviterLocale(db, g.who.id));
  const hash = await recipientHash(email);
  const id = crypto.randomUUID();
  if (
    !(await claimSlot(db, { id, inviterId: g.who.id, hash, masked: maskEmail(email), locale }, now))
  )
    return json({ error: "rate-limited", remaining: 0 }, 429);
  const remaining = Math.max(
    0,
    EMAIL_INVITE.perInviterPerDay - (await usedToday(db, g.who.id, now)),
  );
  const sent = () => json({ status: "sent", remaining });

  const skip = await skipReason(db, g.who.id, email, hash, now);
  if (skip) {
    await setStatus(db, id, skip);
    return sent();
  }
  try {
    const mail = await renderFor(d, g.who.id, { locale, logId: id, to: email });
    const res = (await d.send({
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
    })) as { id?: string } | undefined;
    await setStatus(db, id, "sent", res?.id || undefined);
  } catch {
    logEvent("invite-email.send-failed");
    await setStatus(db, id, "failed");
    // Give the address's window back: nothing reached it.
    await db
      .prepare("DELETE FROM invite_email_recipient WHERE recipientHash = ?1 AND lastSentAt = ?2")
      .bind(hash, now)
      .run();
    return json({ error: "mail-failed" }, 502);
  }
  return json({ status: "sent", remaining });
}

// ── Opting out ────────────────────────────────────────────────────────────────

export type OptOutAction = "unsubscribe" | "report";

/** Suppress the mail's address (and record a report). Idempotent: a repeat changes nothing. */
export async function applyOptOut(
  db: InviteDb,
  logId: string,
  action: OptOutAction,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT recipientHash FROM invite_email_log WHERE id = ?1")
    .bind(logId)
    .first<{ recipientHash: string }>();
  if (!row) return false;
  await db
    .prepare(
      `INSERT INTO invite_email_suppression (recipientHash, reason, createdAt) VALUES (?1, ?2, ?3)
       ON CONFLICT(recipientHash) DO UPDATE SET reason = 'abuse'
       WHERE ?2 = 'abuse' AND reason = 'unsubscribe'`,
    )
    .bind(row.recipientHash, action === "report" ? "abuse" : "unsubscribe", now)
    .run();
  if (action === "report")
    await db
      .prepare("UPDATE invite_email_log SET reportedAt = ?2 WHERE id = ?1 AND reportedAt IS NULL")
      .bind(logId, now)
      .run();
  return true;
}

/**
 * POST /api/invite/email/opt-out — no sign-in:
 * - RFC 8058 one-click: `?t=<token>`, form body `List-Unsubscribe=One-Click`
 *   (sent by the mail client, so from no origin of ours) → unsubscribe;
 * - the opt-out page: same-origin JSON `{token, action}`.
 */
export async function inviteOptOut(req: Request, d: EmailInviteDeps): Promise<Response> {
  const now = (d.now ?? Date.now)();
  const db = d.db();
  const ip = await hit(
    db,
    ipKey("invite-optout", clientIp(req.headers)),
    EMAIL_INVITE.optOutPerIp,
    now,
  );
  if (!ip.allowed) return json({ error: "rate-limited" }, 429);
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  let token: unknown;
  let action: OptOutAction = "unsubscribe";
  if (type === "application/json") {
    if (!sameOriginJson(req)) return json({ error: "forbidden" }, 403);
    const body = (await req.json().catch(() => null)) as {
      token?: unknown;
      action?: unknown;
    } | null;
    token = body?.token;
    if (body?.action === "report") action = "report";
    else if (body?.action !== "unsubscribe") return json({ error: "invalid" }, 400);
  } else if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
    const form = await req.formData().catch(() => null);
    if (form?.get("List-Unsubscribe") !== "One-Click") return json({ error: "invalid" }, 400);
    token = new URL(req.url).searchParams.get("t");
  } else {
    return json({ error: "invalid" }, 400);
  }
  const logId = await verifyOptOut(d.secret(), token);
  if (!logId || !(await applyOptOut(db, logId, action, now)))
    return json({ error: "invalid" }, 400);
  logEvent(action === "report" ? "invite-email.reported" : "invite-email.unsubscribed");
  return json({ status: "done", action });
}

/** GET on the one-click URL (a person, or a client that only GETs): the page, nothing changed. */
export function optOutGet(req: Request, origin: string): Response {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const lang = new URL(req.url).searchParams.get("lang") ?? "";
  const { optOutUrl } = optOutLinks(origin, mailTemplateLocale(lang) ?? "en", t);
  return new Response(null, { status: 303, headers: { location: optOutUrl } });
}
