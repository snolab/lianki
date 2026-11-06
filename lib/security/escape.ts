/**
 * Escaping for the few places that build markup from strings instead of
 * React: the legacy HTML pages in app/fsrs.ts, and text sent to Slack.
 */

/** Text or an attribute value in HTML (both quote kinds). */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** U+2028 / U+2029, which end a line inside a JS string in older engines. */
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");

/**
 * A value as a JS literal inside an inline <script>: JSON, with `<`, `>`, `&`
 * and the line separators escaped so the string can never close the script
 * element or open a comment.
 */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/** An href the page may link to: http(s) only, escaped; anything else is "#". */
export function safeHref(url: unknown): string {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return escapeHtml(u.href);
  } catch {}
  return "#";
}

/**
 * User text in a Slack message: `&`, `<`, `>` escaped as Slack asks, so the
 * text cannot make a link, a mention (`<!channel>`, `<@U…>`) or a channel
 * reference. Slack's own escaping covers exactly these three characters.
 */
export function escapeSlack(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
