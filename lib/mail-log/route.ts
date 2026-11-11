/**
 * What /api/dev/mails does once the route has asked who is calling (isDev;
 * `who` null = not a developer → an empty 404, like every /api/dev route).
 * Plain functions over deps, so the unit tests drive every answer.
 * docs/mail-templates.md, "Send log".
 *
 *   GET  ?template&status&locale&from&to&q&page  → the log, newest first, + per-day counts
 *   GET  ?id=…                                   → one mail, re-rendered from its template
 *   GET  ?view=suppression&page                  → invite_email_suppression
 *   POST {op:"resend", id}       → the same mail again (never a sign-in code or link,
 *                                  never to a suppressed address; invites under every
 *                                  invite limit)
 *   POST {op:"suppress", id}     → no invite mail to that row's address again
 *   POST {op:"unsuppress", hash} → take an address off the list
 *
 * Addresses leave only in these answers, to a developer. Nothing here logs one.
 */
import { NextResponse } from "next/server";
import type { D1Like } from "@/lib/d1/types";
import type { SendEmailInput } from "@/lib/email";
import { composeMail, renderBuiltin, renderWith } from "@/lib/mail-templates/compose";
import { MAIL_TEMPLATE_IDS, isMailTemplateId } from "@/lib/mail-templates/defs";
import type { TemplateSource } from "@/lib/mail-templates/engine";
import { MAIL_LOCALES, isMailLocale } from "@/lib/mail-templates/locales";
import type { TemplateDb } from "@/lib/mail-templates/store";
import { inviteOne, type EmailInviteDeps, type InviteDb } from "@/lib/referrals/email-invite";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { hit, type ThrottleDb } from "@/lib/security/throttle";
import {
  MAIL_STATUSES,
  PAGE_SIZE,
  getMail,
  isMailStatus,
  isSuppressed,
  listMails,
  listSuppression,
  perDay,
  suppress,
  unsuppress,
  type MailFilter,
  type MailRow,
} from "./store";
import { NO_RESEND, parseVars, rerenderValues } from "./vars";

export type MailsCaller = { id: string };
export type MailsDb = D1Like & ThrottleDb & AuditDb;

export type MailsDeps = {
  db: () => MailsDb | null;
  /** The logged send (lib/mail-log/deliver.ts): a stub on a local server. */
  send: (mail: SendEmailInput) => Promise<{ id?: string } | unknown>;
  /** Where invite links point, and the opt-out tokens' key (as the invite route). */
  origin: () => string;
  secret: () => string | undefined;
  now?: () => number;
};

/** Resends per developer: a few by hand, never a mailing tool. */
export const RESENDS = { max: 10, windowMs: 10 * 60_000 };

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

const DAY_MS = 24 * 3600_000;
/** A YYYY-MM-DD day in JST → its first millisecond. */
export function jstDay(s: string | null): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00+09:00`);
  return Number.isFinite(t) ? t : null;
}

function filterOf(q: URLSearchParams): MailFilter {
  const template = q.get("template");
  const status = q.get("status");
  const locale = q.get("locale");
  const to = jstDay(q.get("to"));
  return {
    template: isMailTemplateId(template) || template === "unknown" ? template : null,
    status: isMailStatus(status) ? status : null,
    locale: isMailLocale(locale) ? locale : null,
    from: jstDay(q.get("from")),
    to: to === null ? null : to + DAY_MS,
    q: q.get("q")?.slice(0, 200) ?? null,
  };
}

const pageOf = (q: URLSearchParams) => {
  const n = Number(q.get("page") ?? 0);
  return Number.isInteger(n) && n >= 0 && n < 10_000 ? n : 0;
};

const listItem = (r: MailRow) => ({
  id: r.id,
  createdAt: r.createdAt,
  template: r.template,
  version: r.version,
  locale: r.locale,
  recipient: r.recipient,
  masked: !!r.masked,
  status: r.status,
  reason: r.reason,
  providerId: r.providerId,
  resendOf: r.resendOf,
});

/** Why this mail may not be sent again, before any limit is counted; null = it may. */
export async function resendRefusal(
  db: MailsDb,
  r: MailRow,
): Promise<"not-resendable" | "no-address" | "suppressed" | "no-inviter" | null> {
  if (!isMailTemplateId(r.template) || NO_RESEND.has(r.template) || r.version < 0)
    return "not-resendable";
  if (r.masked) return "no-address";
  if (r.template === "invite" && !r.inviterId) return "no-inviter";
  if (await isSuppressed(db, r.recipientHash)) return "suppressed";
  return null;
}

type Rendered =
  | { ok: true; mail: TemplateSource; placeholders: string[] }
  | { ok: false; error: "test-draft" | "unknown-template" | "version-missing" | "render-failed" };

/** The mail as it was sent: its template version, its kept variables, placeholders for the rest. */
export async function rerender(db: MailsDb, r: MailRow): Promise<Rendered> {
  if (r.version < 0) return { ok: false, error: "test-draft" };
  if (!isMailTemplateId(r.template) || !isMailLocale(r.locale))
    return { ok: false, error: "unknown-template" };
  const { values, placeholders } = rerenderValues(r.template, parseVars(r.vars), r.recipient);
  try {
    if (r.version === 0)
      return { ok: true, mail: renderBuiltin(r.template, r.locale, values), placeholders };
    const src = await db
      .prepare(
        "SELECT subject, html, text FROM mail_template_version WHERE template = ?1 AND locale = ?2 AND version = ?3",
      )
      .bind(r.template, r.locale, r.version)
      .first<TemplateSource>();
    if (!src) return { ok: false, error: "version-missing" };
    return { ok: true, mail: renderWith(r.template, r.locale, src, values), placeholders };
  } catch {
    return { ok: false, error: "render-failed" };
  }
}

export async function mailsGet(req: Request, who: MailsCaller | null, d: MailsDeps) {
  const db = who ? d.db() : null;
  if (!db) return notFound();
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  if (id !== null) {
    const r = id.length <= 64 ? await getMail(db, id) : null;
    if (!r) return json({ error: "not-found" }, 404);
    const [rendered, refusal, suppressed] = await Promise.all([
      rerender(db, r),
      resendRefusal(db, r),
      isSuppressed(db, r.recipientHash),
    ]);
    return json({
      mail: {
        ...listItem(r),
        updatedAt: r.updatedAt,
        userId: r.userId,
        inviterId: r.inviterId,
        recipientHash: r.recipientHash,
        vars: parseVars(r.vars),
      },
      rendered,
      resend: refusal ?? "ok",
      suppressed,
    });
  }
  if (q.get("view") === "suppression") {
    const page = pageOf(q);
    const { rows, total } = await listSuppression(db, page);
    return json({
      rows: rows.map((s) => ({ ...s, masked: s.masked === null ? null : !!s.masked })),
      total,
      page,
      pageSize: PAGE_SIZE,
    });
  }
  const f = filterOf(q);
  const page = pageOf(q);
  const [{ rows, total }, days] = await Promise.all([listMails(db, f, page), perDay(db, f)]);
  return json({
    rows: rows.map(listItem),
    total,
    page,
    pageSize: PAGE_SIZE,
    perDay: days,
    templates: [...MAIL_TEMPLATE_IDS, "unknown"],
    locales: MAIL_LOCALES,
    statuses: MAIL_STATUSES,
  });
}

type Body = { op?: unknown; id?: unknown; hash?: unknown };

const HASH = /^[0-9a-f]{64}$/;

async function resend(db: MailsDb, who: MailsCaller, r: MailRow, d: MailsDeps, now: number) {
  const refusal = await resendRefusal(db, r);
  if (refusal) return json({ error: refusal }, 409);
  const limit = await hit(db, `mail-resend:${who.id}`, RESENDS, now);
  if (!limit.allowed) return json({ error: "rate-limited", retryAfterMs: limit.retryAfterMs }, 429);
  const template = r.template as Exclude<
    (typeof MAIL_TEMPLATE_IDS)[number],
    "signin-code" | "signin-link" | "email-confirm"
  >;
  const locale = isMailLocale(r.locale) ? r.locale : "en";
  if (template === "invite") {
    // The invite path itself, as the inviter: every invite limit applies.
    const got = await inviteOne(
      {
        db: () => db as unknown as InviteDb,
        send: d.send,
        origin: d.origin,
        secret: d.secret,
      } satisfies Pick<EmailInviteDeps, "db" | "send" | "origin" | "secret">,
      { inviterId: r.inviterId!, email: r.recipient, locale, resendOf: r.id },
      now,
    );
    if (got.status === "rate-limited") return json({ error: "invite-limit" }, 409);
    if (got.status === "failed") return json({ error: "send-failed" }, 502);
    if (got.status !== "sent") return json({ error: "invite-skipped", why: got.status }, 409);
  } else {
    const { values, placeholders } = rerenderValues(template, parseVars(r.vars), r.recipient);
    // A value that was not kept would go out as "{name}": never send that.
    if (placeholders.length) return json({ error: "cannot-render" }, 422);
    // The template as it is sent today (a broken edit falls back to the built-in).
    const mail = await composeMail(db as unknown as TemplateDb, template, locale, values);
    try {
      await d.send({
        to: r.recipient,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        log: { ...mail.log, userId: r.userId, inviterId: r.inviterId, resendOf: r.id },
      });
    } catch {
      console.error(JSON.stringify({ event: "mail-log.resend-failed", template }));
      return json({ error: "send-failed" }, 502);
    }
  }
  await audit(db, { kind: "mail-log.resend", actor: who.id, subject: r.id, detail: template }, now);
  return json({ status: "sent" });
}

export async function mailsPost(req: Request, who: MailsCaller | null, d: MailsDeps) {
  const db = who ? d.db() : null;
  if (!who || !db) return notFound();
  if (!sameOriginJsonPost(req)) return json({ error: "forbidden" }, 403);
  const b = (await req.json().catch(() => null)) as Body | null;
  const now = (d.now ?? Date.now)();

  if (b?.op === "unsuppress") {
    if (typeof b.hash !== "string" || !HASH.test(b.hash)) return json({ error: "invalid" }, 400);
    const removed = await unsuppress(db, b.hash);
    if (removed)
      await audit(
        db,
        { kind: "mail-log.unsuppress", actor: who.id, subject: b.hash.slice(0, 12) },
        now,
      );
    return json({ removed });
  }

  if (b?.op !== "resend" && b?.op !== "suppress") return json({ error: "invalid" }, 400);
  const r = typeof b.id === "string" && b.id.length <= 64 ? await getMail(db, b.id) : null;
  if (!r) return json({ error: "not-found" }, 404);

  if (b.op === "suppress") {
    await suppress(db, r.recipientHash, now);
    await audit(db, { kind: "mail-log.suppress", actor: who.id, subject: r.id }, now);
    return json({ status: "suppressed" });
  }
  return resend(db, who, r, d, now);
}
