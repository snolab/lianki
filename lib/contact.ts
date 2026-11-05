/**
 * The contact address users write to (e.g. to ask for a top-up), from
 * `CONTACT_EMAIL` in wrangler.jsonc `vars`. Unset or blank means none: the
 * UI hides the contact line. Server-side only; pass the value down as a prop.
 */
export function contactEmail(raw: string | undefined = process.env.CONTACT_EMAIL): string | null {
  const email = raw?.trim();
  return email ? email : null;
}
