/**
 * Language tags for mail to people who are not (yet) reading the app:
 *
 * - `normaliseLocaleTag` turns a browser tag into one of ours. Chinese keeps its
 *   script: zh, zh-CN, zh-SG, zh-Hans… → `zh-Hans`; zh-TW, zh-HK, zh-MO,
 *   zh-Hant… → `zh-Hant`. Every other language is its base subtag when it is one
 *   of the app's 16 locales, else nothing.
 * - `signupLocaleFrom` picks the best such tag from an Accept-Language header,
 *   by its q-weights. Only the tag is kept (`user.signupLocale`,
 *   db/migrations/0062_user_signup_locale.sql), written once at the account's
 *   first sign-up and never overwritten; accounts made before stay null.
 * - `mailTemplateLocale` maps a tag to the template's locale. The templates have
 *   one Chinese, Simplified (`zh`): zh-Hans reads it. zh-Hant has no template of
 *   its own and also gets `zh` — never the other way round.
 * - `inviterMailLocale`: the account language the inviter set → their
 *   signupLocale → en.
 *
 * Pure: no D1, no request objects. Client-safe.
 */
import { BLOG_LOCALES, isSupportedLocale } from "@/lib/constants";

export type MailTemplateLocale = (typeof BLOG_LOCALES)[number];

const HANT_REGIONS = new Set(["tw", "hk", "mo"]);

/** A browser's tag → `zh-Hans` | `zh-Hant` | one of the 16 base locales, or null. */
export function normaliseLocaleTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().replace(/_/g, "-").toLowerCase().split("-").filter(Boolean);
  const base = parts[0];
  if (!base || !/^[a-z]{2,3}$/.test(base)) return null;
  if (base === "zh") {
    if (parts.includes("hant")) return "zh-Hant";
    if (parts.includes("hans")) return "zh-Hans";
    return parts.slice(1).some((p) => HANT_REGIONS.has(p)) ? "zh-Hant" : "zh-Hans";
  }
  return isSupportedLocale(base) ? base : null;
}

/** The best supported tag in an Accept-Language header (q-weights honoured), or null. */
export function signupLocaleFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const ranked = header
    .slice(0, 500)
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.split(";").map((s) => s.trim());
      const q = params.find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const { tag } of ranked) {
    const hit = normaliseLocaleTag(tag);
    if (hit) return hit;
  }
  return null;
}

/** A tag (any form) → the mail template's locale, or null when we have none for it. */
export function mailTemplateLocale(tag: unknown): MailTemplateLocale | null {
  const n = normaliseLocaleTag(tag);
  if (!n) return null;
  return (n.startsWith("zh-") ? "zh" : n) as MailTemplateLocale;
}

/**
 * The inviter's mail language: (1) the language they set on their account
 * (`ui.locale`), (2) the browser language at their first sign-up, (3) English.
 */
export function inviterMailLocale(who: {
  accountLocale?: string | null;
  signupLocale?: string | null;
}): MailTemplateLocale {
  return mailTemplateLocale(who.accountLocale) ?? mailTemplateLocale(who.signupLocale) ?? "en";
}
