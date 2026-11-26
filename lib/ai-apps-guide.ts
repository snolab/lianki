/**
 * The public guide to connecting an AI chat app (ChatGPT, Claude, Gemini) to a
 * Lianki account: /guides/ai-apps (docs/api-for-agents.md, "The public guide").
 * Pure, so the token page, the agent guide and the page share one path.
 */

/** The guide's route (a collection noun, docs/url-principles.md rule 3). */
export const AI_APPS_GUIDE_PATH = "/guides/ai-apps";
export const AI_APPS_GUIDE_URL = `https://lianki.com${AI_APPS_GUIDE_PATH}`;

/** The page's sections, in order; ids are the in-page anchors. Product names stay as is. */
export const AI_APPS = [
  { id: "chatgpt", name: "ChatGPT" },
  { id: "claude", name: "Claude" },
  { id: "gemini", name: "Gemini" },
] as const;

/** When the third-party menu names were last checked by hand (ISO, UTC). */
export const AI_APPS_CHECKED_ON = "2026-11-27";

/** Fills `{name}` placeholders; an unknown one is left as written. */
export function fillGuide(text: unknown, vars: Record<string, unknown>): string {
  return String(text).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The checked-on date in the reader's language, e.g. "27 November 2026". */
export function checkedOn(locale: string): string {
  const d = new Date(`${AI_APPS_CHECKED_ON}T00:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(d);
  } catch {
    return AI_APPS_CHECKED_ON;
  }
}
