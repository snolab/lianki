// Which entry a word in the reader means, when more than one language's
// dictionary has it (owner, 2026-11-05 14:21 JST: 「云」 in a Japanese line of a
// mixed doc showed the Chinese HSK entry "(classical) to say", as if it were
// the meaning there, and the word had no audio).
//
// - The word's own language (its line's, lib/read/lang-detect.ts) comes
//   first: its entries before any other language's. An entry of another
//   language is still shown, labelled with its language — never as the
//   meaning here.
// - When the entries come from more than one language (a Han word that is
//   both Japanese and Chinese), the card lists each and he picks the one
//   that fits; the word is read aloud in the picked entry's language from
//   then on. A matched entry he did not pick never changes how the book's
//   text is read.
// - Picks follow the account (`read.sensePicks`, docs/prefs-sync.md), keyed
//   by the word and its sentence; the same word in another sentence takes
//   his latest pick for it. Small: the newest PICKS_MAX, under the pref cap.
//
// Data only, no language named here: the languages come from the book.

export const PICKS_KEY = "lk:read-sense-picks";
/** The newest picks kept (each about 40 bytes; the pref's cap is 2 KB). */
export const PICKS_MAX = 24;

/** One language's entry for the selected text. */
export interface SenseEntry {
  lang: string;
  term: string;
  back: string;
  reading?: string | null;
}

/** word@sentence → "lang\tterm", oldest first. */
export type SensePicks = Record<string, string>;

/** A short, stable hash of the sentence (FNV-1a, 8 hex digits). */
export function ctxHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const pickKey = (surface: string, sentence: string) =>
  `${surface.trim()}@${ctxHash(sentence.trim())}`;

export const choiceOf = (e: Pick<SenseEntry, "lang" | "term">) => `${e.lang}\t${e.term}`;

/** His pick for this word here: in this sentence, else his latest for the word. */
export function pickFor(picks: SensePicks, surface: string, sentence: string): string | null {
  const exact = picks[pickKey(surface, sentence)];
  if (exact) return exact;
  const prefix = `${surface.trim()}@`;
  let last: string | null = null;
  for (const [k, v] of Object.entries(picks)) if (k.startsWith(prefix)) last = v;
  return last;
}

/** The picks with this one newest, the oldest dropped past PICKS_MAX. */
export function withPick(
  picks: SensePicks,
  surface: string,
  sentence: string,
  choice: string,
): SensePicks {
  const key = pickKey(surface, sentence);
  const entries = Object.entries(picks).filter(([k]) => k !== key);
  entries.push([key, choice]);
  return Object.fromEntries(entries.slice(-PICKS_MAX));
}

/** Untrusted stored picks (localStorage, the account's copy). */
export function checkPicks(v: unknown): SensePicks {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: SensePicks = {};
  for (const [k, c] of Object.entries(v as Record<string, unknown>))
    if (
      typeof c === "string" &&
      k.length <= 80 &&
      c.length <= 60 &&
      /^[a-z]{2,3}\t./.test(c) &&
      /@[0-9a-f]{8}$/.test(k)
    )
      out[k] = c;
  return Object.fromEntries(Object.entries(out).slice(-PICKS_MAX));
}

export interface SenseView {
  /** The entry shown as the meaning. */
  main: SenseEntry;
  /** The other languages' entries, to pick from (empty: nothing to pick). */
  others: SenseEntry[];
  /** The main entry is another language's than the word's own: label it so. */
  cross: boolean;
  /** He picked the main entry. */
  picked: boolean;
}

/**
 * The card's view of the entries found (each language's, in the order
 * searched): his pick, else the word's own language's first, else the first.
 * Repeats (the same language and term) are dropped.
 */
export function senseView(
  found: readonly SenseEntry[],
  wordLang: string,
  pick: string | null,
): SenseView | null {
  const seen = new Set<string>();
  const all = found.filter((e) => {
    const k = choiceOf(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!all.length) return null;
  const picked = pick ? all.find((e) => choiceOf(e) === pick) : undefined;
  const main = picked ?? all.find((e) => e.lang === wordLang) ?? all[0];
  return {
    main,
    others: all.filter((e) => e !== main),
    cross: main.lang !== wordLang,
    picked: !!picked,
  };
}

/** A language's name in the UI's language ("ja" in a Chinese UI → "日语"), else its code. */
export function langLabel(tag: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The language a word is read aloud in: his pick's, else its own. */
export function voiceLangOf(pick: string | null, wordLang: string): string {
  const m = pick ? /^([a-z]{2,3})\t./.exec(pick) : null;
  return m ? m[1] : wordLang;
}
