"use client";

/**
 * The preferred languages on this device (lib/lang-order.ts): what the user
 * picked in Settings (`lk:lang-preferred`, synced as `lang.preferred`), or,
 * while they have picked nothing, the automatic list — the language they
 * study (`lk:home:lang`), the app's language and the browser's.
 *
 * Each language also carries how well the user knows it (lib/lang-levels.ts):
 * `items` and `levelOf`, `setLevel` to change one. Setting a level on the
 * automatic list makes it the user's own.
 *
 * Before mount (and on the server) `langs` is null, so a page renders in its
 * own order first and hydration agrees; it reorders right after.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLocale } from "next-intlayer";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { defaultPreferred, PREFERRED_LANGS_KEY } from "@/lib/lang-order";
import {
  encodeItems,
  langLevelOf,
  normalizeItems,
  parseStoredItems,
  type LangLevel,
  type PrefLang,
} from "@/lib/lang-levels";

/** Fired on this tab after a local write, so every hook re-reads. */
const LOCAL_EVENT = "lk:lang-preferred";
/** The language studied on /home (SitesClient), when one was picked. */
const LEARNING_KEY = "lk:home:lang";

function subscribe(cb: () => void) {
  window.addEventListener(PREF_APPLIED_EVENT, cb);
  window.addEventListener("storage", cb);
  window.addEventListener(LOCAL_EVENT, cb);
  window.addEventListener("languagechange", cb);
  return () => {
    window.removeEventListener(PREF_APPLIED_EVENT, cb);
    window.removeEventListener("storage", cb);
    window.removeEventListener(LOCAL_EVENT, cb);
    window.removeEventListener("languagechange", cb);
  };
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/** One string, so the snapshot compares by value. */
function snapshot() {
  return JSON.stringify([
    read(PREFERRED_LANGS_KEY),
    read(LEARNING_KEY),
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? [navigator.language])],
  ]);
}

/**
 * Store `list` ([] = back to automatic) and tell the sync engine and the page.
 * Plain tags keep the level already stored for them; `{ lang, level }` items
 * set it.
 */
export function writePreferred(list: readonly (string | PrefLang)[]) {
  const had = parseStoredItems(read(PREFERRED_LANGS_KEY));
  const items = normalizeItems(
    list.map((it) => (typeof it === "string" ? { lang: it, level: langLevelOf(had, it) } : it)),
  );
  try {
    localStorage.setItem(PREFERRED_LANGS_KEY, JSON.stringify(encodeItems(items)));
  } catch {}
  notePrefWrite();
  try {
    window.dispatchEvent(new Event(LOCAL_EVENT));
  } catch {}
}

export function usePreferredLangs() {
  const { locale } = useLocale();
  const snap = useSyncExternalStore(subscribe, snapshot, () => null);
  const state = useMemo(() => {
    if (snap === null) return null;
    const [stored, learning, browser] = JSON.parse(snap) as [
      string | null,
      string | null,
      string[],
    ];
    const own = parseStoredItems(stored);
    const picks = own.map((it) => it.lang);
    const auto = defaultPreferred({
      learning: learning ? [learning] : [],
      ui: String(locale ?? ""),
      browser,
    });
    const items: PrefLang[] = own.length
      ? own
      : auto.map((lang) => ({ lang, level: "unset" as const }));
    return { picks, auto, langs: picks.length ? picks : auto, items };
  }, [snap, locale]);
  const set = useCallback((list: readonly string[]) => writePreferred(list), []);
  const reset = useCallback(() => writePreferred([]), []);
  const items = state?.items;
  const setLevel = useCallback(
    (lang: string, level: LangLevel) =>
      writePreferred((items ?? []).map((it) => (it.lang === lang ? { lang, level } : it))),
    [items],
  );
  const levelOf = useCallback((lang: string) => langLevelOf(items, lang), [items]);
  return {
    /** The order to use, or null before mount. */
    langs: state?.langs ?? null,
    /** What the user picked; [] while automatic. */
    picks: state?.picks ?? [],
    /** The automatic list (browser, app and studied languages). */
    auto: state?.auto ?? [],
    /** True while nothing is picked. */
    automatic: !state?.picks.length,
    /** The list in use with each language's level (unset on the automatic list), or null before mount. */
    items: items ?? null,
    /** The user's level in a language (lib/lang-levels.ts `langLevelOf`). */
    levelOf,
    set,
    setLevel,
    reset,
  };
}
