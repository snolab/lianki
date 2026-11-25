/** Public source context only: never query, fragment, credentials or an automatic redirect. */
export function portableSource(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (
      (u.protocol !== "https:" && u.protocol !== "http:") ||
      u.username ||
      u.password ||
      u.origin.length > 100
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}
export function portableChatPath(source?: unknown): string {
  const from = portableSource(source);
  return from ? "/chat?from=" + encodeURIComponent(from) : "/chat";
}
