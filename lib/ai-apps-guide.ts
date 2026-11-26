/**
 * The public guide to connecting an AI chat app (ChatGPT, Claude, Gemini) to a
 * Lianki account: /guides/ai-apps (docs/api-for-agents.md, "The public guide").
 * Pure, so the token page, the agent guide and the page share one path.
 *
 * Owner, 2026-11-27: "不要复述任何他们的内容". The page never restates another
 * app's steps, plans or limits; it links that app's own help page and states
 * only what Lianki needs: the address, the sign-in choice, and @Lianki.
 */

/** The guide's route (a collection noun, docs/url-principles.md rule 3). */
export const AI_APPS_GUIDE_PATH = "/guides/ai-apps";
export const AI_APPS_GUIDE_URL = `https://lianki.com${AI_APPS_GUIDE_PATH}`;

/** Where "Something here wrong? Tell us" goes: Lianki's contact page. */
export const AI_APPS_FEEDBACK_PATH = "/contact";

/**
 * The page's sections, in order; ids are the in-page anchors. Product names stay
 * as is. `help` is the maker's own page on adding a custom connector (and who
 * may); `auth` is that app's own label for the no-sign-in choice, shown as is
 * (null: leave the sign-in settings empty); `at`: the chat takes @Lianki.
 */
export const AI_APPS = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    help: "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt",
    auth: "No authentication",
    at: true,
  },
  {
    id: "claude",
    name: "Claude",
    help: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    auth: "No sign in",
    at: false,
  },
  {
    id: "gemini",
    name: "Gemini",
    help: "https://support.google.com/gemini/answer/17209137",
    auth: null,
    at: true,
  },
] as const;

/** Fills `{name}` placeholders; an unknown one is left as written. */
export function fillGuide(text: unknown, vars: Record<string, unknown>): string {
  return String(text).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
