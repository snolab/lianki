/**
 * Invite by email: every limit in one object (docs/payments.md, "Invite by
 * email"). First values, picked by the agent on 2026-11-09; the owner may change
 * any of them. Client-safe: no D1, no secrets.
 */
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const EMAIL_INVITE = {
  /** The flag that opens it to every Pro user; off = admins only. */
  flag: "membership.email-invite",
  /** Invite mails one inviter may ask for in any 24 hours (sent or quietly not). */
  perInviterPerDay: 5,
  /** The rolling window of that limit. */
  inviterWindowMs: DAY,
  /** One invite mail per address in this many days, whoever sends it. */
  perRecipientDays: 30,
  /** An inviter whose mails were reported this many times sends no more. */
  blockAfterReports: 2,
  /** The window those reports are counted in. */
  reportWindowMs: 365 * DAY,
  /** Rows of the inviter's own (masked) history shown on /membership. */
  historyRows: 20,
  /** Longest display name put into a mail; longer ones are cut. */
  nameMaxChars: 40,
  /** One-click unsubscribe / report requests per IP (the endpoint takes no session). */
  optOutPerIp: { max: 30, windowMs: 15 * 60_000 },
} as const;

/**
 * The Resend tag every invite mail carries: its `invite_email_log` id. Resend
 * echoes tags in its webhook events, so a complaint names the invite and counts
 * against its inviter (lib/resend-webhook.ts).
 */
export const INVITE_LOG_TAG = "invite_log";

export const RECIPIENT_WINDOW_MS = EMAIL_INVITE.perRecipientDays * DAY;

/**
 * The compliance footer's sender block (CAN-SPAM / CASL). `postalAddress` is a
 * slot: CAN-SPAM asks for a valid physical postal address in commercial mail,
 * and the repo has none on record. It stays null — and the footer leaves the
 * line out — until the owner gives one; nothing is invented here.
 */
export const INVITE_MAIL_SENDER = {
  name: "Lianki",
  site: "https://lianki.com",
  /** The contact the site publishes (a form; there is no published support mailbox). */
  contactUrl: "https://lianki.com/contacts",
  postalAddress: null as string | null,
} as const;
