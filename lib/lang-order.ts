/**
 * Preferred languages (docs/prefs-sync.md, `lang.preferred`): one setting
 * that orders every place offering material in many languages — the /words
 * and /alphabet "Add a list" tree, the /books library and its library guide.
 * Preferred languages first, in the user's order; the rest keep the order the
 * page already had.
 *
 * Matching is by language data only (BCP 47, CLDR canonical forms through
 * Intl), never per-language code: a tag matches its own base language
 * (`zh-Hans` ~ `zh`, `pt-BR` ~ `pt`), and deprecated codes are canonicalised
 * (`iw` → `he`). An exact match outranks a base-only one for the same pick.
 *
 * Pure: no storage, no DOM. The hook is lib/use-preferred-langs.ts.
 */

/** The localStorage copy of the setting, synced as `lang.preferred`. Absent or [] = automatic. */
export const PREFERRED_LANGS_KEY = "lk:lang-preferred";
/** Picks one account may keep (named limit, ready for the config store). */
export const PREFERRED_LANGS_MAX = 24;
/** A BCP 47 tag as stored: a 2–3 letter language and optional subtags, nothing else. */
export const LANG_TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
/** Longest stored tag. */
export const LANG_TAG_MAX = 24;

/** `tag` in its canonical BCP 47 form (`zh-hans` → `zh-Hans`, `iw` → `he`), or null when it is not a language tag. */
export function canonicalLang(tag: string): string | null {
  const t = tag.trim().replace(/_/g, "-");
  if (!t || t.length > 35) return null;
  try {
    const [c] = Intl.getCanonicalLocales(t);
    if (!c) return null;
    // Only languages: "und", private use and the like name none.
    const base = c.split("-")[0].toLowerCase();
    if (!/^[a-z]{2,3}$/.test(base) || base === "und" || base === "mul" || base === "zxx")
      return null;
    return c;
  } catch {
    return null;
  }
}

/** The language subtag of `tag` (`zh-Hans-CN` → `zh`), canonical; "" for anything else. */
export function baseLang(tag: string): string {
  const c = canonicalLang(tag);
  return c ? c.split("-")[0].toLowerCase() : "";
}

/**
 * How well a preference matches a language: 2 exact, 1 the same base
 * language, 0 none. Case and `_` do not matter.
 */
export function langMatch(pref: string, lang: string): 0 | 1 | 2 {
  const a = canonicalLang(pref);
  const b = canonicalLang(lang);
  if (!a || !b) return 0;
  if (a.toLowerCase() === b.toLowerCase()) return 2;
  return a.split("-")[0].toLowerCase() === b.split("-")[0].toLowerCase() ? 1 : 0;
}

/**
 * A clean preference list: canonical tags, no duplicates (a tag repeated, or
 * a base language already covered exactly), at most PREFERRED_LANGS_MAX.
 */
export function normalizePreferred(tags: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const c = canonicalLang(t);
    if (!c || c.length > LANG_TAG_MAX || !LANG_TAG_RE.test(c)) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= PREFERRED_LANGS_MAX) break;
  }
  return out;
}

/** The stored copy (`lk:lang-preferred`) as a clean list; [] = automatic. */
export function parseStored(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? normalizePreferred(v) : [];
  } catch {
    return [];
  }
}

/**
 * The automatic list, before the user picks: the languages they study, then
 * the app's language, then the browser's (navigator.languages /
 * Accept-Language). Region variants of a language already listed are dropped
 * (`en-US` after `en`), so the list reads as languages.
 */
export function defaultPreferred(src: {
  learning?: readonly string[];
  ui?: string | null;
  browser?: readonly string[];
}): string[] {
  const all = normalizePreferred([...(src.learning ?? []), src.ui ?? "", ...(src.browser ?? [])]);
  const bases = new Set<string>();
  const out: string[] = [];
  for (const t of all) {
    const b = t.split("-")[0].toLowerCase();
    if (bases.has(b)) continue;
    bases.add(b);
    out.push(t);
  }
  return out;
}

/**
 * `items` with the preferred languages first, in the order of `prefs`; the
 * rest after them, in the order they came. Stable: items of the same rank
 * keep their order. An item whose language is exactly a pick comes before
 * one that only shares its base language.
 */
export function orderByPreferred<T>(
  items: readonly T[],
  langOf: (item: T) => string | null | undefined,
  prefs: readonly string[] | null | undefined,
): T[] {
  if (!prefs?.length || items.length < 2) return [...items];
  const cache = new Map<string, number>();
  const rank = (lang: string | null | undefined): number => {
    if (!lang) return Infinity;
    const hit = cache.get(lang);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (let i = 0; i < prefs.length && best === Infinity; i++) {
      const m = langMatch(prefs[i], lang);
      if (m) best = i * 2 + (m === 2 ? 0 : 1);
    }
    cache.set(lang, best);
    return best;
  };
  return items
    .map((item, i) => ({ item, i, r: rank(langOf(item)) }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r < b.r ? -1 : 1))
    .map((x) => x.item);
}

/**
 * Languages offered by the panel's "Add a language" menu: the world's most
 * spoken and most studied languages, as ISO 639 codes (data; names come from
 * Intl.DisplayNames in the reader's language). Anything a page offers can be
 * added from there too, since a page's languages are passed in beside these.
 */
export const LANG_CHOICES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
  "it",
  "tr",
  "vi",
  "th",
  "fa",
  "pl",
  "uk",
  "nl",
  "sv",
  "fi",
  "no",
  "da",
  "el",
  "he",
  "cs",
  "hu",
  "ro",
  "ms",
  "tl",
  "ta",
  "te",
  "pa",
  "gu",
  "kn",
  "ml",
  "my",
  "km",
  "lo",
  "ne",
  "si",
  "yue",
  "la",
  "eo",
  "ga",
  "cy",
  "ca",
  "eu",
  "gl",
  "is",
  "et",
  "lv",
  "lt",
  "sk",
  "sl",
  "hr",
  "sr",
  "bg",
  "mk",
  "sq",
  "hy",
  "ka",
  "az",
  "kk",
  "uz",
  "mn",
  "am",
  "ha",
  "yo",
  "zu",
  "xh",
  "af",
] as const;
