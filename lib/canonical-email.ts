/**
 * The canonical form of an email address, used ONLY to tell that two accounts
 * are one person (owner, 2026-11-05, Slack 14:31 JST): the 90-day trial, invite
 * and gift-code rewards, and per-person rate limits. Identity and sign-in keep
 * the address as given (lowercased) — this never merges or renames accounts.
 *
 * Stored as `user.email_canonical` (db/migrations/0043_email_canonical.sql,
 * whose SQL backfill mirrors these rules; unit/canonical-email.test.ts pins
 * the two together).
 */

/** Providers that ignore dots in the local part, mapped to the one domain they share. */
export const DOTLESS_DOMAINS: Readonly<Record<string, string>> = {
  "gmail.com": "gmail.com",
  "googlemail.com": "gmail.com",
};

/**
 * Providers known to deliver `name+anything@` to `name@`. Any other domain
 * keeps its `+suffix`: elsewhere it may be a different mailbox.
 */
export const PLUS_ALIAS_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
];

export function canonicalEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  // No local part, or more than one "@": leave it alone (the SQL backfill does too).
  if (at <= 0 || e.indexOf("@") !== at) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (PLUS_ALIAS_DOMAINS.includes(domain)) {
    const plus = local.indexOf("+");
    if (plus > 0) local = local.slice(0, plus);
  }
  const dotless = DOTLESS_DOMAINS[domain];
  if (dotless) {
    local = local.replaceAll(".", "");
    domain = dotless;
  }
  return `${local}@${domain}`;
}
