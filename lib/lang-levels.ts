/**
 * How well the user knows each preferred language (owner, 2026-11-15 JST:
 * "偏好语言列表应该允许用户设置他们的熟悉程度或者语言级别程度"). One generic
 * table, never per-language code: `native`, `fluent`, the CEFR levels C2 … A1,
 * and `unset` (nothing said).
 *
 * Stored inside the preferred-language list itself (`lk:lang-preferred`,
 * synced as `lang.preferred`, docs/prefs-sync.md): an item is a plain tag
 * (`"ja"`, the old shape, level unset) or `{ lang, level }`. A list without
 * levels is written exactly as before, so the old shape keeps working both
 * ways. The order and matching rules are lib/lang-order.ts.
 *
 * Pure: no storage, no DOM. The hook is lib/use-preferred-langs.ts.
 */
import { canonicalLang, langMatch, normalizePreferred } from "@/lib/lang-order";

/**
 * The levels, best first. `rank` orders them (higher = knows it better);
 * `label` is the key of its name in app/components/preferred-langs.content.ts,
 * or null when the code itself is the name (CEFR: "B2" in every language).
 */
export const LANG_LEVELS = [
  { id: "native", rank: 8, label: "levelNative" },
  { id: "fluent", rank: 7, label: "levelFluent" },
  { id: "c2", rank: 6, label: null },
  { id: "c1", rank: 5, label: null },
  { id: "b2", rank: 4, label: null },
  { id: "b1", rank: 3, label: null },
  { id: "a2", rank: 2, label: null },
  { id: "a1", rank: 1, label: null },
  { id: "unset", rank: 0, label: "levelUnset" },
] as const;

export type LangLevel = (typeof LANG_LEVELS)[number]["id"];
/** Every level id, best first. */
export const LANG_LEVEL_IDS = LANG_LEVELS.map((l) => l.id) as unknown as readonly [
  LangLevel,
  ...LangLevel[],
];
/** The ids a stored item may carry (an unset level is stored as a plain tag). */
export const STORED_LEVEL_IDS = LANG_LEVEL_IDS.filter((l) => l !== "unset") as unknown as readonly [
  Exclude<LangLevel, "unset">,
  ...Exclude<LangLevel, "unset">[],
];

/** One preferred language and how well the user knows it. */
export type PrefLang = { lang: string; level: LangLevel };
/** An item as stored and synced: the old plain tag, or a tag with its level. */
export type StoredPrefLang = string | { lang: string; level: Exclude<LangLevel, "unset"> };

const BY_ID = new Map(LANG_LEVELS.map((l) => [l.id as string, l]));

export function isLangLevel(v: unknown): v is LangLevel {
  return typeof v === "string" && BY_ID.has(v);
}

/** Higher = known better; 0 for unset or anything unknown. */
export function levelRank(level: unknown): number {
  return isLangLevel(level) ? BY_ID.get(level)!.rank : 0;
}

/** Native or fluent: a language to explain things in, not one being learnt. */
export function knowsWell(level: unknown): boolean {
  return levelRank(level) >= levelRank("fluent");
}

/** How a level is written where no label is translated: CEFR in capitals, the rest as is. */
export function levelCode(level: LangLevel): string {
  return BY_ID.get(level)!.label === null ? level.toUpperCase() : level;
}

/**
 * A clean list of items from either stored shape: canonical tags in order, no
 * duplicates (lib/lang-order.ts's rules), each with its level (unset when the
 * item was a plain tag or its level is unknown).
 */
export function normalizeItems(raw: readonly unknown[]): PrefLang[] {
  const levels = new Map<string, LangLevel>();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const { lang, level } = it as { lang?: unknown; level?: unknown };
    const c = typeof lang === "string" ? canonicalLang(lang) : null;
    if (c && isLangLevel(level) && !levels.has(c.toLowerCase())) levels.set(c.toLowerCase(), level);
  }
  return normalizePreferred(raw).map((lang) => ({
    lang,
    level: levels.get(lang.toLowerCase()) ?? "unset",
  }));
}

/** The stored copy as items; [] when absent or unreadable. */
export function parseStoredItems(raw: string | null): PrefLang[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? normalizeItems(v) : [];
  } catch {
    return [];
  }
}

/** Items as stored: an unset level is the old plain tag, so a list without levels is unchanged. */
export function encodeItems(items: readonly PrefLang[]): StoredPrefLang[] {
  return normalizeItems(items).map(({ lang, level }) =>
    level === "unset" ? lang : { lang, level },
  );
}

/**
 * The user's level in `lang`: the item matching it exactly, else one with the
 * same base language (`zh-Hans` for `zh`); `unset` when none says.
 */
export function langLevelOf(
  items: readonly PrefLang[] | null | undefined,
  lang: string,
): LangLevel {
  let base: LangLevel | null = null;
  for (const it of items ?? []) {
    const m = langMatch(it.lang, lang);
    if (m === 2) return it.level;
    if (m === 1 && base === null && it.level !== "unset") base = it.level;
  }
  return base ?? "unset";
}

/**
 * The language to explain or translate into. `fallback` (the app's language)
 * stays, unless the user marked a language they know better: then the first
 * native one in their list, else the first fluent one — never the language
 * being explained (`source`). With no levels set this is always `fallback`,
 * so nothing changes for anyone who has not picked a level.
 */
export function explainIn(
  items: readonly PrefLang[] | null | undefined,
  fallback: string,
  source?: string | null,
): string {
  const notSource = (l: string) => !source || langMatch(l, source) === 0;
  if (knowsWell(langLevelOf(items, fallback)) && notSource(fallback)) return fallback;
  for (const want of ["native", "fluent"] as const) {
    const hit = (items ?? []).find((it) => it.level === want && notSource(it.lang));
    if (hit) return hit.lang;
  }
  return fallback;
}

/**
 * One line naming the user's languages and levels, for a prompt
 * (docs/partner-ai.md): "zh native; en C1; ja A2; fr". Empty when there are none.
 */
export function levelsLine(items: readonly PrefLang[]): string {
  return items
    .map((it) => (it.level === "unset" ? it.lang : `${it.lang} ${levelCode(it.level)}`))
    .join("; ");
}
