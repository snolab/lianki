/**
 * Invite rules, as the owner set them (2026-10-29, #lianki thread
 * 1793252008.414719). Both sides gain, but the inviter only for an invite that
 * turned into real studying, so made-up accounts earn nothing.
 */

/** Extra trial days for someone who signs up through an invite (90 → 120). */
export const INVITEE_TRIAL_DAYS = 30;
/** Pro days for the inviter once the invitee is active. */
export const INVITER_ACTIVATED_DAYS = 30;
/** Pro days for the inviter when the invitee buys their first pass. */
export const INVITER_PURCHASE_DAYS = 30;
/** Most Pro days invites can earn one person in any 365 days (owner: 12 months, provisional). */
export const YEARLY_CAP_DAYS = 365;

/** Active = reviewed on this many distinct days… */
export const ACTIVATION_REVIEW_DAYS = 7;
/** …within this many days of accepting the invite. */
export const ACTIVATION_WINDOW_DAYS = 30;

/** An invite only counts for an account at most this old — not for existing users. */
export const CLAIM_MAX_ACCOUNT_AGE_H = 72;

export const DAY_MS = 24 * 60 * 60 * 1000;

// No 0/O, 1/I/L: codes get read aloud and typed from screenshots.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Normalise what a person typed or a link carried; null when it cannot be a code. */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[0-9A-Z]{4,32}$/.test(code) ? code : null;
}

/** How many of `want` days the cap still allows, given what was earned in the last 365 days. */
export function cappedDays(want: number, earnedLastYear: number, cap = YEARLY_CAP_DAYS): number {
  return Math.max(0, Math.min(want, cap - earnedLastYear));
}

/** The span in which an invitee's reviews count toward activation. */
export function activationWindow(invitedAt: Date): { from: Date; to: Date } {
  return { from: invitedAt, to: new Date(invitedAt.getTime() + ACTIVATION_WINDOW_DAYS * DAY_MS) };
}

/** Mask an email for the inviter's list: `a***@gmail.com`. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "***";
  return `${name.slice(0, 1)}***@${domain}`;
}
