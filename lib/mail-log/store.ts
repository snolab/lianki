/**
 * The send log in D1 (db/migrations/0065_mail_log.sql; docs/mail-templates.md,
 * "Send log"). Writes: a row per mail (queued), then sent / failed from the
 * provider's answer, then delivered / bounced / complained / unsubscribed from
 * Resend's webhook and the invite opt-out. Reads: /dev/mails only.
 *
 * Statuses only move forward: a late "delivered" never undoes a complaint,
 * and a failed mail stays failed.
 */
import type { D1Like } from "@/lib/d1/types";

export type MailLogDb = Pick<D1Like, "prepare">;

export const MAIL_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];
export const isMailStatus = (v: unknown): v is MailStatus =>
  typeof v === "string" && (MAIL_STATUSES as readonly string[]).includes(v);

/** The statuses a later event may replace. */
const FROM: Record<"delivered" | "bounced" | "complained" | "unsubscribed", readonly MailStatus[]> =
  {
    delivered: ["queued", "sent"],
    bounced: ["queued", "sent", "delivered"],
    unsubscribed: ["queued", "sent", "delivered"],
    complained: ["queued", "sent", "delivered", "bounced", "unsubscribed"],
  };
export type EventStatus = keyof typeof FROM;

export type NewMailRow = {
  id: string;
  template: string;
  version: number;
  locale: string;
  recipient: string;
  recipientHash: string;
  userId?: string | null;
  inviterId?: string | null;
  inviteLogId?: string | null;
  vars?: Record<string, string> | null;
  resendOf?: string | null;
};

export async function insertQueued(db: MailLogDb, r: NewMailRow, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mail_log (id, created_at, updated_at, template, version, locale, recipient,
         recipient_hash, user_id, inviter_id, invite_log_id, vars, status, resend_of)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'queued', ?12)`,
    )
    .bind(
      r.id,
      now,
      r.template,
      r.version,
      r.locale,
      r.recipient,
      r.recipientHash,
      r.userId ?? null,
      r.inviterId ?? null,
      r.inviteLogId ?? null,
      r.vars ? JSON.stringify(r.vars) : null,
      r.resendOf ?? null,
    )
    .run();
}

/** The provider accepted it: its message id, and `sent` unless an event already moved it on. */
export async function markSent(db: MailLogDb, id: string, providerId: string, now: number) {
  await db
    .prepare(
      `UPDATE mail_log SET provider_id = ?2, updated_at = ?3,
         status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END
       WHERE id = ?1`,
    )
    .bind(id, providerId || null, now)
    .run();
}

/** The provider refused it (or the call failed): a short reason, never an address. */
export async function markFailed(db: MailLogDb, id: string, reason: string, now: number) {
  await db
    .prepare(
      "UPDATE mail_log SET status = 'failed', reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'queued'",
    )
    .bind(id, shortReason(reason), now)
    .run();
}

const EMAIL_RE = /[^\s@<>"']+@[^\s@<>"']+/g;

/** At most 200 characters, with anything shaped like an address cut out. */
export const shortReason = (s: string) => s.replace(EMAIL_RE, "<address>").slice(0, 200);

/** Find the logged mail an event is about: by its mail_log tag, else Resend's message id. */
export async function findForEvent(
  db: MailLogDb,
  tagId: string | null,
  providerId: string | null,
): Promise<string | null> {
  if (tagId) {
    const r = await db
      .prepare("SELECT id FROM mail_log WHERE id = ?1")
      .bind(tagId)
      .first<{ id: string }>();
    if (r) return r.id;
  }
  if (providerId) {
    const r = await db
      .prepare("SELECT id FROM mail_log WHERE provider_id = ?1 LIMIT 1")
      .bind(providerId)
      .first<{ id: string }>();
    if (r) return r.id;
  }
  return null;
}

/** Move one row to an event's status, if that is forward. Returns whether it moved. */
export async function applyEventStatus(
  db: MailLogDb,
  where: { id: string } | { inviteLogId: string },
  status: EventStatus,
  now: number,
  reason?: string | null,
): Promise<boolean> {
  const from = FROM[status];
  const marks = from.map((_, i) => `?${i + 5}`).join(", ");
  const [col, key] = "id" in where ? ["id", where.id] : ["invite_log_id", where.inviteLogId];
  const r = await db
    .prepare(
      `UPDATE mail_log SET status = ?2, updated_at = ?3, reason = COALESCE(?4, reason)
       WHERE ${col} = ?1 AND status IN (${marks}) RETURNING id`,
    )
    .bind(key, status, now, reason ? shortReason(reason) : null, ...from)
    .all<{ id: string }>();
  return r.results.length > 0;
}

// ── Reads (/dev/mails) ────────────────────────────────────────────────────────

export type MailRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  template: string;
  version: number;
  locale: string;
  recipient: string;
  masked: number;
  recipientHash: string;
  userId: string | null;
  inviterId: string | null;
  inviteLogId: string | null;
  vars: string | null;
  status: MailStatus;
  reason: string | null;
  providerId: string | null;
  resendOf: string | null;
};

const COLS = `id, created_at AS createdAt, updated_at AS updatedAt, template, version, locale,
  recipient, recipient_masked AS masked, recipient_hash AS recipientHash, user_id AS userId,
  inviter_id AS inviterId, invite_log_id AS inviteLogId, vars, status, reason,
  provider_id AS providerId, resend_of AS resendOf`;

export type MailFilter = {
  template?: string | null;
  status?: string | null;
  locale?: string | null;
  /** Inclusive start / exclusive end, epoch ms. */
  from?: number | null;
  to?: number | null;
  /** Part of an address, or a whole message id / row id. */
  q?: string | null;
};

function whereOf(f: MailFilter): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    parts.push(sql.replace("?", `?${args.length}`));
  };
  if (f.template) add("template = ?", f.template);
  if (f.status) add("status = ?", f.status);
  if (f.locale) add("locale = ?", f.locale);
  if (f.from != null) add("created_at >= ?", f.from);
  if (f.to != null) add("created_at < ?", f.to);
  const q = f.q?.trim();
  if (q) {
    // instr, not LIKE: D1 refuses a LIKE pattern over 50 bytes, and an
    // address is often longer. No wildcards to escape either.
    args.push(q.toLowerCase(), q);
    const a = args.length - 1;
    parts.push(`(instr(lower(recipient), ?${a}) > 0 OR provider_id = ?${a + 1} OR id = ?${a + 1})`);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

export const PAGE_SIZE = 50;

export async function listMails(
  db: MailLogDb,
  f: MailFilter,
  page: number,
): Promise<{ rows: MailRow[]; total: number }> {
  const w = whereOf(f);
  const n = w.args.length;
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT ${COLS} FROM mail_log ${w.sql} ORDER BY created_at DESC, id LIMIT ?${n + 1} OFFSET ?${n + 2}`,
      )
      .bind(...w.args, PAGE_SIZE, Math.max(0, page) * PAGE_SIZE)
      .all<MailRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM mail_log ${w.sql}`)
      .bind(...w.args)
      .first<{ n: number }>(),
  ]);
  return { rows: rows.results, total: Number(total?.n ?? 0) };
}

/** JST: the owner's day (docs: times in JST). */
const JST_S = 9 * 3600;

/** Mails per JST day and status under the same filter, newest day first, at most `days` days. */
export async function perDay(
  db: MailLogDb,
  f: MailFilter,
  days = 14,
): Promise<{ day: string; status: string; n: number }[]> {
  const w = whereOf(f);
  const n = w.args.length;
  const { results } = await db
    .prepare(
      `SELECT date(created_at / 1000 + ${JST_S}, 'unixepoch') AS day, status, COUNT(*) AS n
         FROM mail_log ${w.sql}
        GROUP BY day, status
        ORDER BY day DESC
        LIMIT ?${n + 1}`,
    )
    .bind(...w.args, days * MAIL_STATUSES.length)
    .all<{ day: string; status: string; n: number }>();
  const keep = new Set([...new Set(results.map((r) => r.day))].slice(0, days));
  return results.filter((r) => keep.has(r.day)).map((r) => ({ ...r, n: Number(r.n) }));
}

export async function getMail(db: MailLogDb, id: string): Promise<MailRow | null> {
  return db.prepare(`SELECT ${COLS} FROM mail_log WHERE id = ?1`).bind(id).first<MailRow>();
}

// ── Suppression (invite_email_suppression) ────────────────────────────────────

export type SuppressionRow = {
  recipientHash: string;
  reason: string;
  createdAt: number;
  /** The newest logged address with this hash; masked when only a masked one is known. */
  recipient: string | null;
  masked: number | null;
};

export async function listSuppression(db: MailLogDb, page: number) {
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT s.recipientHash, s.reason, s.createdAt,
           (SELECT m.recipient FROM mail_log m WHERE m.recipient_hash = s.recipientHash
              ORDER BY m.recipient_masked ASC, m.created_at DESC LIMIT 1) AS recipient,
           (SELECT m.recipient_masked FROM mail_log m WHERE m.recipient_hash = s.recipientHash
              ORDER BY m.recipient_masked ASC, m.created_at DESC LIMIT 1) AS masked
         FROM invite_email_suppression s
         ORDER BY s.createdAt DESC LIMIT ?1 OFFSET ?2`,
      )
      .bind(PAGE_SIZE, Math.max(0, page) * PAGE_SIZE)
      .all<SuppressionRow>(),
    db.prepare("SELECT COUNT(*) AS n FROM invite_email_suppression").first<{ n: number }>(),
  ]);
  return { rows: rows.results, total: Number(total?.n ?? 0) };
}

export async function isSuppressed(db: MailLogDb, hash: string): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 AS hit FROM invite_email_suppression WHERE recipientHash = ?1")
    .bind(hash)
    .first());
}

/** Suppress by hand (reason `manual`); an existing reason stays. */
export async function suppress(db: MailLogDb, hash: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO invite_email_suppression (recipientHash, reason, createdAt) VALUES (?1, 'manual', ?2)
       ON CONFLICT(recipientHash) DO NOTHING`,
    )
    .bind(hash, now)
    .run();
}

export async function unsuppress(db: MailLogDb, hash: string): Promise<boolean> {
  const r = await db
    .prepare(
      "DELETE FROM invite_email_suppression WHERE recipientHash = ?1 RETURNING recipientHash",
    )
    .bind(hash)
    .all();
  return r.results.length > 0;
}
