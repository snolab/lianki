/**
 * Review filters stay on one device (docs/prefs-sync.md, owner 2026-11-05):
 * /preferences keeps them in this browser's localStorage, and the userscript,
 * which applies them on other sites, mirrors them into its own GM storage when
 * it runs on lianki.com.
 *
 * The account's old copy (`mobileExcludePatterns`) is left where it is. A phone
 * with nothing of its own keeps using it, as it always did, so updating loses
 * no filter; a desktop never did, and doesn't start.
 */
export const REVIEW_FILTERS_KEY = "lk:review-filters";
/** Fired on the page after a save, so the userscript mirrors without a reload. */
export const REVIEW_FILTERS_EVENT = "lk:review-filters-changed";

export interface FilterPattern {
  id: string;
  type: "domain" | "title" | "url";
  pattern: string;
  isRegex: boolean;
  enabled: boolean;
  createdAt: string;
}

export const isMobileAgent = (ua: string) => /Mobi|Android|iPhone|iPad/i.test(ua);

/** A stored list, or null when this device has none (an empty list is an answer). */
export function parseFilters(raw: unknown): FilterPattern[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as FilterPattern[]) : null;
  } catch {
    return null;
  }
}

/** The filters this device goes by. */
export function deviceFilters(
  own: unknown,
  isMobile: boolean,
  accountCopy: FilterPattern[] | undefined,
): FilterPattern[] {
  return parseFilters(own) ?? (isMobile ? (accountCopy ?? []) : []);
}

/** The userscript on lianki.com: copy the page's list to where other sites can read it. */
export function mirrorReviewFilters(
  store: Pick<Storage, "getItem">,
  setValue: (k: string, v: string) => void,
) {
  try {
    const raw = store.getItem(REVIEW_FILTERS_KEY);
    if (parseFilters(raw)) setValue(REVIEW_FILTERS_KEY, raw as string);
  } catch {}
}
