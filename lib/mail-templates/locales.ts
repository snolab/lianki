/**
 * Mail languages (docs/mail-templates.md): the app's 16 locales plus
 * `zh-Hant`. Chinese has two variants in mail: `zh` is Simplified (zh, zh-CN,
 * zh-SG, zh-Hans all read it) and `zh-Hant` is Traditional (zh-TW, zh-HK,
 * zh-MO, zh-Hant). The UI has one Chinese; mail has both.
 *
 * The recipient's language: the account's (`ui.locale`) → the browser language
 * recorded at sign-up (`signupLocale`) → the request's (only where the request
 * comes from the recipient, e.g. a sign-in code) → English. A plain `zh` says
 * nothing about the script, so when the next source is a Traditional tag that
 * one decides the script.
 *
 * Pure: no D1, no request objects. Client-safe.
 */
import { BLOG_LOCALES } from "@/lib/constants";
import { normaliseLocaleTag } from "@/lib/signup-locale";

export const MAIL_LOCALES = [...BLOG_LOCALES, "zh-Hant"] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];

export const RTL_MAIL_LOCALES: ReadonlySet<string> = new Set(["ar", "ur"]);

export const isMailLocale = (v: unknown): v is MailLocale =>
  typeof v === "string" && (MAIL_LOCALES as readonly string[]).includes(v);

/** Any tag (`zh-TW`, `zh_Hans`, `ja-JP`) → a mail locale, or null when we have none for it. */
export function mailLocaleOf(tag: unknown): MailLocale | null {
  const n = normaliseLocaleTag(tag);
  if (!n) return null;
  if (n === "zh-Hant") return "zh-Hant";
  if (n === "zh-Hans") return "zh";
  return isMailLocale(n) ? n : null;
}

/** Did the tag name a script or a Chinese region, i.e. is its `zh` a deliberate Simplified? */
function zhScriptExplicit(tag: unknown): boolean {
  if (typeof tag !== "string") return false;
  const parts = tag.trim().replace(/_/g, "-").toLowerCase().split("-");
  return parts.length > 1;
}

/**
 * The first usable tag of `sources`, in order. A bare `zh` lets a later
 * Traditional source pick `zh-Hant` (the UI's `zh` setting cannot say which
 * script a Taiwanese reader wants); any other hit ends the search.
 */
export function pickMailLocale(...sources: unknown[]): MailLocale {
  for (let i = 0; i < sources.length; i++) {
    const hit = mailLocaleOf(sources[i]);
    if (!hit) continue;
    if (hit === "zh" && !zhScriptExplicit(sources[i])) {
      const later = sources.slice(i + 1).map(mailLocaleOf);
      const next = later.find((l) => l !== null);
      if (next === "zh-Hant") return "zh-Hant";
    }
    return hit;
  }
  return "en";
}
