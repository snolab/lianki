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
 *   why you got it (a friend, one time), the address it was sent to beside a
 *   visible Unsubscribe link, and Report abuse; the postal address line only
 *   once INVITE_MAIL_SENDER has one.
 * - The recipient's address is only rendered into this one message: never
 *   stored, never logged (the log keeps a hash and a masked form).
 * - Headers: List-Unsubscribe with the https one-click URL and
 *   List-Unsubscribe-Post (RFC 8058). No mailto: there is no inbound mailbox.
 *
 * Colours are oklch() (owner rule). A mail client without oklch ignores the
 * declaration and uses its defaults, which stay readable.
 */
import { renderBuiltin } from "@/lib/mail-templates/compose";
import { inviteCopy } from "@/lib/mail-templates/defs";
import type { MailLocale } from "@/lib/mail-templates/locales";
import { EMAIL_INVITE, INVITE_MAIL_SENDER } from "./email-invite-config";
import { INVITEE_TRIAL_DAYS } from "./rules";

/** The trial every new account starts with (lib/membership.ts). */
const BASE_TRIAL_DAYS = 90;

export type InviteMailCopy = ReturnType<typeof inviteCopy>;

/** The template's strings in `locale` (zh-Hant included); a missing translation falls back to English. */
export const inviteMailCopy = (locale: MailLocale): InviteMailCopy => inviteCopy(locale);

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
  locale: MailLocale;
  /**
   * The address the mail goes to, exactly as sent: shown in the footer ("This
   * email was sent to …"). Rendered only — never stored or logged.
   */
  recipient: string;
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

/** The values of template `invite` (lib/mail-templates/defs.ts) for one mail. */
export function inviteMailValues(input: InviteMailInput): Record<string, string> {
  const c = inviteMailCopy(input.locale);
  return {
    inviter: mailDisplayName(input.inviterName) ?? c.aFriend,
    address: input.recipient,
    inviteUrl: input.inviteUrl,
    unsubscribeUrl: input.optOutUrl,
    reportUrl: input.reportUrl,
    extraDays: String(INVITEE_TRIAL_DAYS),
    baseDays: String(BASE_TRIAL_DAYS),
    totalDays: String(BASE_TRIAL_DAYS + INVITEE_TRIAL_DAYS),
    site: INVITE_MAIL_SENDER.site.replace(/^https:\/\//, ""),
    contactUrl: INVITE_MAIL_SENDER.contactUrl,
    postal: INVITE_MAIL_SENDER.postalAddress ?? "",
  };
}

/** List-Unsubscribe with the https one-click URL and List-Unsubscribe-Post (RFC 8058). Code, not template. */
export function inviteMailHeaders(oneClickUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** The built-in invite mail (no stored edit): previews and tests. */
export function renderInviteMail(input: InviteMailInput): RenderedInviteMail {
  const { subject, text, html } = renderBuiltin("invite", input.locale, inviteMailValues(input));
  return { subject, text, html, headers: inviteMailHeaders(input.oneClickUrl) };
}

/** The opt-out page's two links. The token rides in the fragment: no server log or Referer sees it. */
export function optOutLinks(origin: string, locale: string, token: string) {
  // The page speaks the UI's 16 locales: one Chinese, so zh-Hant opens it in `zh`.
  const ui = locale === "zh-Hant" ? "zh" : locale;
  const page = `${origin}/membership/invite-opt-out?lang=${encodeURIComponent(ui)}`;
  const t = encodeURIComponent(token);
  return { optOutUrl: `${page}#t=${t}`, reportUrl: `${page}#t=${t}&report=1` };
}

/** The address a preview shows in its "sent to" line: never a real one. */
export const PREVIEW_RECIPIENT = "friend@example.com";

/**
 * The mail as a recipient would get it, with placeholder links: for showing the
 * owner before any real send (GET /api/dev/invite-mail-preview renders his own).
 */
export function previewInviteMail(opts: {
  locale: MailLocale;
  inviterName: string | null | undefined;
  code?: string;
  origin?: string;
}): RenderedInviteMail {
  const origin = opts.origin ?? INVITE_MAIL_SENDER.site;
  return renderInviteMail({
    locale: opts.locale,
    recipient: PREVIEW_RECIPIENT,
    inviterName: opts.inviterName,
    inviteUrl: `${origin}/i/${opts.code ?? "PREVIEW"}`,
    ...optOutLinks(origin, opts.locale, "preview"),
    oneClickUrl: `${origin}/api/invite/email/opt-out?t=preview&lang=${opts.locale}`,
  });
}
