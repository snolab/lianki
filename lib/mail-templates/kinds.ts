/**
 * Which mails a person can turn off, and how (owner request 2026-11-10;
 * docs/mail-templates.md, "Unsubscribe: the three classes"). ONE table, data
 * only: the send path (lib/mail-log/send.ts), the layout's footer
 * (./layout.ts), the preferences page and the unsubscribe page all read it.
 *
 * - `required`: no unsubscribe. The mail is the action the reader just asked
 *   for (a sign-in code or link, a confirm link) or the one way to tell them
 *   about their own account (receipts, email-change notices).
 * - `security`: on by default; can be turned off, but only in
 *   /my/preferences, behind a short warning. The footer says how.
 * - `optional`: everything else. One click turns it off: a footer link and
 *   List-Unsubscribe + List-Unsubscribe-Post (RFC 8058) headers, with a
 *   signed token per user and kind (./unsubscribe-token.ts), no sign-in.
 *   An invite goes to someone with no account, so its opt-out is by address
 *   (`invite-address`: lib/referrals, invite_email_suppression) instead.
 *
 * Pure and client-safe.
 */
import type { MailTemplateId } from "./defs";

export type MailClass = "required" | "security" | "optional";
/** How a mail is turned off: never; in preferences only; one click (per user); by address (no account). */
export type MailOptOut = "none" | "preferences" | "one-click" | "invite-address";

export type MailKind = {
  class: MailClass;
  optOut: MailOptOut;
  /**
   * The account pref (lib/prefs/schema.ts, synced) that turns it off: a
   * boolean, `false` = do not send. Only for `preferences` and `one-click`.
   */
  pref?: MailPrefKey;
  /** Why it is in this class, for the docs and the PR. English, dev-facing. */
  why: string;
};

/** The account prefs that switch a mail kind off. One per kind that can be turned off. */
export const MAIL_PREF_KEYS = ["mail.loginNotice"] as const;
export type MailPrefKey = (typeof MAIL_PREF_KEYS)[number];

export const MAIL_KINDS: Record<MailTemplateId, MailKind> = {
  "signin-code": {
    class: "required",
    optOut: "none",
    why: "the code the reader just asked for",
  },
  "signin-link": {
    class: "required",
    optOut: "none",
    why: "the link the reader just asked for",
  },
  "email-confirm": {
    class: "required",
    optOut: "none",
    why: "the confirm link of a change the reader just asked for",
  },
  "email-taken": {
    class: "required",
    optOut: "none",
    why: "the answer to a change the reader just asked for",
  },
  "email-requested": {
    class: "required",
    optOut: "none",
    why: "account notice: someone asked to move the account to another address",
  },
  "email-changed": {
    class: "required",
    optOut: "none",
    why: "account notice: the old address must hear that the account moved",
  },
  "login-notice": {
    class: "security",
    optOut: "preferences",
    pref: "mail.loginNotice",
    why: "security notice: off only in /my/preferences, after a warning",
  },
  invite: {
    class: "optional",
    optOut: "invite-address",
    why: "a mail to someone with no account: one-click opt-out by address",
  },
};

/** Mail kinds whose footer and headers carry the per-user one-click unsubscribe. */
export const oneClickKinds = (kinds: Record<string, MailKind> = MAIL_KINDS): string[] =>
  Object.entries(kinds)
    .filter(([, k]) => k.optOut === "one-click" && k.pref)
    .map(([id]) => id);

/** The pref that switches `template` off for an account, or null when it cannot be turned off. */
export function mailPrefOf(
  template: string,
  kinds: Record<string, MailKind> = MAIL_KINDS,
): MailPrefKey | null {
  const k = kinds[template];
  return k && (k.optOut === "preferences" || k.optOut === "one-click") && k.pref ? k.pref : null;
}
