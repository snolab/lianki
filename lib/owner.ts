/**
 * Owner gate for internal pages (e.g. /dev/roadmap).
 *
 * `OWNER_EMAILS` is a comma-separated list, set in wrangler.jsonc `vars`.
 * Unset or empty means nobody is the owner — the gate fails closed.
 */
export function ownerEmails(raw: string | undefined = process.env.OWNER_EMAILS): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwner(
  email: string | null | undefined,
  raw: string | undefined = process.env.OWNER_EMAILS,
): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return ownerEmails(raw).includes(normalized);
}
