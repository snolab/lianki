/** A language's name in `locale`; its code when the browser has no name for it. */
export function langName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
