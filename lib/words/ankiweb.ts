/**
 * The curated AnkiWeb shared decks on /words/import (docs/wordlists-pipeline.md
 * §1a, §3a). Lianki only links to AnkiWeb: it never fetches, searches or
 * mirrors it (robots.txt disallows /shared/decks/ and the download endpoints,
 * and the deck licence is personal use). The user downloads a deck in their own
 * browser and drops the .apkg back on the page; the list stays private.
 */
import data from "./ankiweb-decks.json";

export type AnkiWebDeck = {
  /** AnkiWeb shared deck id: the page is ankiweb.net/shared/info/<id>. */
  id: string;
  /** The deck's name, so the user recognises it on AnkiWeb. */
  title: string;
  /** BCP 47 base code of the language studied. */
  lang: string;
  level: string;
  /** "personal" (AnkiWeb terms) or the licence the author states. */
  licence: string;
  licenceNote?: string;
  /** One sentence of our own; never AnkiWeb's text. */
  description: string;
};

export const ANKIWEB_DECKS: AnkiWebDeck[] = data.decks;
/** When the ids were last checked (ISO date). */
export const ANKIWEB_CHECKED: string = data.checked;

/** AnkiWeb's own search page; opened in the user's browser only, never fetched. */
export const ANKIWEB_SEARCH_URL = "https://ankiweb.net/shared/decks?search=";
const INFO_URL = "https://ankiweb.net/shared/info/";

/** The licence recorded on lists imported from an AnkiWeb deck. */
export const ANKIWEB_LICENCE = "AnkiWeb (personal use)";

export const ankiWebInfoUrl = (id: string) => INFO_URL + id;
export const ankiWebSearchUrl = (q: string) => ANKIWEB_SEARCH_URL + encodeURIComponent(q.trim());

/** A deck page link as typed or pasted → its canonical URL, or null. */
export function parseAnkiWebUrl(raw: string): string | null {
  const m = raw
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?ankiweb\.net\/shared\/info\/(\d{1,12})\b/i);
  return m ? ankiWebInfoUrl(m[1]) : null;
}

/** The pattern the import API accepts for a deck's source link. */
export const ANKIWEB_INFO_RE = /^https:\/\/ankiweb\.net\/shared\/info\/\d{1,12}$/;

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Client-side search over the curated list only: every word of the query must
 * appear in the deck's title, level, description, language code or the
 * language's name (passed in, in the UI language and in English).
 */
export function searchDecks(
  q: string,
  decks: AnkiWebDeck[] = ANKIWEB_DECKS,
  langNames: (code: string) => string[] = () => [],
): AnkiWebDeck[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return decks;
  return decks.filter((d) => {
    const hay = fold(
      [d.title, d.level, d.description, d.lang, d.licence, ...langNames(d.lang)].join(" "),
    );
    return words.every((w) => hay.includes(w));
  });
}

/** The curated deck an .apkg most likely came from, by its deck name. */
export function matchDeck(apkgName: string, decks: AnkiWebDeck[] = ANKIWEB_DECKS) {
  const norm = (s: string) =>
    fold(s)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const name = norm(apkgName.split("::")[0]);
  if (!name) return undefined;
  return decks.find((d) => {
    const t = norm(d.title);
    return t === name || name.includes(t) || (name.length >= 8 && t.includes(name));
  });
}
