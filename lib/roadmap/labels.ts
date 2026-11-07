/** `{name}` placeholders in a translated string, filled in. Unknown names stay as written. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * The singular or the other form of a count string for `locale`
 * (Intl.PluralRules "one" vs everything else), `{n}` filled in with the
 * locale's digits. Locales with more forms (ru, ar) keep agreement out of the
 * "other" text by writing it as a label ("Шагов: {n}"), per the key's context.
 */
export function countLabel(locale: string, n: number, one: string, other: string): string {
  let isOne = n === 1;
  try {
    isOne = new Intl.PluralRules(locale).select(n) === "one";
  } catch {}
  let num = String(n);
  try {
    num = n.toLocaleString(locale);
  } catch {}
  return fill(isOne ? one : other, { n: num });
}
