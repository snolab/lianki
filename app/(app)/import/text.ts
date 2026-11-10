/**
 * intlayer values as plain strings for /import's client sections: a placeholder,
 * a `title`, or a template with `{n}`-style slots filled in.
 */
export const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);

export const fill = (s: unknown, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text(s));

/** A template split around one `{slot}`, for wrapping the value in markup. */
export const around = (s: unknown, slot: string): [string, string] => {
  const str = text(s);
  const i = str.indexOf(`{${slot}}`);
  return i < 0 ? [str, ""] : [str.slice(0, i), str.slice(i + slot.length + 2)];
};
