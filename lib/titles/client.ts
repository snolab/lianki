/**
 * Page titles as the app shows them (docs/title-clean.md): the card's stored
 * title without its notification prefix, by the rules that follow the account
 * (`titles.rules`, kept on the device in `lk:title-rules`). Display only: this
 * never writes a title back.
 */
import {
  activeTitleRules,
  cleanTitle,
  parseTitleRulesPref,
  type TitleRule,
  type TitleRulesPref,
} from "@lianki/core/titleClean";

export const TITLE_RULES_KEY = "lk:title-rules";

let memo: { raw: string | null; pref: TitleRulesPref } | null = null;

/** This device's copy of the preference. Reads as the defaults on the server. */
export function readTitleRulesPref(): TitleRulesPref {
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(TITLE_RULES_KEY);
  } catch {}
  if (memo && memo.raw === raw) return memo.pref;
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {}
  const pref = parseTitleRulesPref(value);
  memo = { raw, pref };
  return pref;
}

export const currentTitleRules = (): readonly TitleRule[] => activeTitleRules(readTitleRulesPref());

/**
 * A card's title to show. Pass the card's url: most rules belong to one site,
 * and without it only the rules for every site run. A missing title stays null.
 */
export function displayTitle(title: string | null | undefined, url?: string | null): string | null {
  if (!title) return title ?? null;
  return cleanTitle(title, { url, rules: currentTitleRules() });
}
