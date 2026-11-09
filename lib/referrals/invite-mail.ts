/**
 * The invite email, the whole template in one module (docs/payments.md, "Invite
 * by email"), so a later /dev/templates editor can take it over: strings from
 * `invite-mail.content.ts` (16 locales, each key with its context line), layout
 * and headers here. Pure — no D1, no secrets, no sending.
 *
 * - Says who invited: the inviter's display name in the subject, the first line
 *   and the footer. A name that is empty or reads like an address or a link is
 *   replaced by "A friend", so nobody can put a URL into someone else's inbox.
 * - Compliance footer (CAN-SPAM / CASL): sender (Lianki, the site), contact,
 *   why you got it (a friend, one time), a visible Unsubscribe link and Report
 *   abuse; the postal address line only once INVITE_MAIL_SENDER has one.
 * - Headers: List-Unsubscribe with the https one-click URL and
 *   List-Unsubscribe-Post (RFC 8058). No mailto: there is no inbound mailbox.
 *
 * Colours are oklch() (owner rule). A mail client without oklch ignores the
 * declaration and uses its defaults, which stay readable.
 */
import { EMAIL_INVITE, INVITE_MAIL_SENDER } from "./email-invite-config";
import dictionary from "./invite-mail.content";
import { INVITEE_TRIAL_DAYS } from "./rules";
import type { MailTemplateLocale } from "@/lib/signup-locale";

/** The trial every new account starts with (lib/membership.ts). */
const BASE_TRIAL_DAYS = 90;

type Key = keyof typeof dictionary.content;
export type InviteMailCopy = Record<Key, string>;

const RTL = new Set(["ar", "ur"]);

/** The template's strings in `locale`; a missing translation falls back to English. */
export function inviteMailCopy(locale: MailTemplateLocale): InviteMailCopy {
  const out = {} as InviteMailCopy;
  for (const [k, node] of Object.entries(dictionary.content)) {
    const tr = (node as unknown as { translation: Record<string, string> }).translation;
    out[k as Key] = tr[locale] ?? tr.en;
  }
  return out;
}

/** A display name fit for someone else's inbox, or null to say "A friend". */
export function mailDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .normalize("NFC")
    // Control and format characters (bidi overrides included) out; whitespace collapsed.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return null;
  // Anything that could be followed: an address, a scheme, a path, a domain.
  if (/[@<>/\\:]|www\.|\.[a-z]{2,}(\b|$)/i.test(name)) return null;
  const chars = [...name];
  return chars.length > EMAIL_INVITE.nameMaxChars
    ? `${chars.slice(0, EMAIL_INVITE.nameMaxChars).join("")}…`
    : name;
}

export type InviteMailInput = {
  locale: MailTemplateLocale;
  /** The inviter's display name as stored; cleaned here. */
  inviterName: string | null | undefined;
  /** lianki.com/i/CODE: the inviter's existing invite link. */
  inviteUrl: string;
  /** The page with the Unsubscribe button (a person clicks). */
  optOutUrl: string;
  /** The same page, opened at Report abuse. */
  reportUrl: string;
  /** The RFC 8058 one-click endpoint (the mail client POSTs). */
  oneClickUrl: string;
};

export type RenderedInviteMail = {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function renderInviteMail(input: InviteMailInput): RenderedInviteMail {
  const c = inviteMailCopy(input.locale);
  const name = mailDisplayName(input.inviterName) ?? c.aFriend;
  const v = {
    name,
    extra: INVITEE_TRIAL_DAYS,
    base: BASE_TRIAL_DAYS,
    total: BASE_TRIAL_DAYS + INVITEE_TRIAL_DAYS,
    site: INVITE_MAIL_SENDER.site.replace(/^https:\/\//, ""),
    url: INVITE_MAIL_SENDER.contactUrl,
  };
  const subject = fill(c.subject, v);
  const invitedBy = fill(c.invitedBy, v);
  const intro = fill(c.intro, v);
  const offer = fill(c.offer, v);
  const why = fill(c.why, v);
  const sender = fill(c.sender, v);
  const contact = fill(c.contact, v);
  const postal = INVITE_MAIL_SENDER.postalAddress;
  const { reportUrl } = input;

  const text = [
    invitedBy,
    "",
    intro,
    "",
    offer,
    "",
    c.cta,
    input.inviteUrl,
    "",
    "—",
    why,
    "",
    c.unsubscribe,
    input.optOutUrl,
    "",
    c.report,
    reportUrl,
    "",
    sender,
    contact,
    ...(postal ? [postal] : []),
  ].join("\n");

  const dir = RTL.has(input.locale) ? "rtl" : "ltr";
  const muted = "color:oklch(0.45 0 0)";
  const html =
    `<div dir="${dir}" lang="${input.locale}" style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">` +
    `<p style="font-weight:700;font-size:18px;margin:0 0 16px">${esc(invitedBy)}</p>` +
    `<p>${esc(intro)}</p>` +
    `<p>${esc(offer)}</p>` +
    `<p style="margin:24px 0"><a href="${esc(input.inviteUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:oklch(0.45 0.18 260);color:oklch(1 0 0);font-weight:700;text-decoration:none">${esc(c.cta)}</a></p>` +
    `<p style="font-size:14px">${esc(c.linkLine)}<br><a href="${esc(input.inviteUrl)}">${esc(input.inviteUrl)}</a></p>` +
    `<hr style="border:none;border-top:1px solid oklch(0.85 0 0);margin:24px 0">` +
    `<p style="font-size:13px;${muted}">${esc(why)}</p>` +
    `<p style="font-size:13px"><a href="${esc(input.optOutUrl)}">${esc(c.unsubscribe)}</a> · <a href="${esc(reportUrl)}">${esc(c.report)}</a></p>` +
    `<p style="font-size:13px;${muted}">${esc(sender)}<br>${esc(contact)}${postal ? `<br>${esc(postal)}` : ""}</p>` +
    `</div>`;

  return {
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** The opt-out page's two links. The token rides in the fragment: no server log or Referer sees it. */
export function optOutLinks(origin: string, locale: string, token: string) {
  const page = `${origin}/membership/invite-opt-out?lang=${encodeURIComponent(locale)}`;
  const t = encodeURIComponent(token);
  return { optOutUrl: `${page}#t=${t}`, reportUrl: `${page}#t=${t}&report=1` };
}

/**
 * The mail as a recipient would get it, with placeholder links: for showing the
 * owner before any real send (GET /api/dev/invite-mail-preview renders his own).
 */
export function previewInviteMail(opts: {
  locale: MailTemplateLocale;
  inviterName: string | null | undefined;
  code?: string;
  origin?: string;
}): RenderedInviteMail {
  const origin = opts.origin ?? INVITE_MAIL_SENDER.site;
  return renderInviteMail({
    locale: opts.locale,
    inviterName: opts.inviterName,
    inviteUrl: `${origin}/i/${opts.code ?? "PREVIEW"}`,
    ...optOutLinks(origin, opts.locale, "preview"),
    oneClickUrl: `${origin}/api/invite/email/opt-out?t=preview&lang=${opts.locale}`,
  });
}
