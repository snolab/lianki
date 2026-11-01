/** The parts of a drill card that decide what is read aloud. */
export type SpokenCard = { term: string; back: string; reading?: string; scene?: string };

/**
 * A phrase card (a scenario phrase deck, lib/words/phrases.ts): a sentence,
 * read as written — the voice reads kanji in context better than kana.
 */
const isPhrase = (it: SpokenCard) => !!it.scene || /[。！？]/.test(it.term);

/**
 * What to say for a card. Native script, never romanization or IPA: a
 * Japanese word's kana reading, the kana side of "a → あ", the letters of
 * "/u/ → ou".
 */
export function spokenText(it: SpokenCard, lang: string, readingOnBack: boolean): string {
  const text = pickSpoken(it, lang, readingOnBack);
  // Nothing sensible to say for IPA, or for pinyin letters a Chinese voice
  // would read as English: stay silent rather than mispronounce.
  if (/^\/.*\/$/.test(text)) return "";
  if (lang === "zh" && /^[\p{Script=Latin}\s]+$/u.test(text)) return "";
  return text;
}

function pickSpoken(it: SpokenCard, lang: string, readingOnBack: boolean): string {
  const firstAlt = (s: string) => s.split(/\s*[/·;]\s*/)[0]?.trim() ?? "";
  const ipa = /^\/.*\/$/;
  const latin = /^[\p{Script=Latin}\s'’-]+$/u;
  if (readingOnBack)
    return lang === "ja" && it.reading && !isPhrase(it) ? firstAlt(it.reading) : it.term;
  // Syllable drills carry example characters ("是 时"); a voice reads those,
  // not bare zhuyin.
  if (lang === "zh" && it.reading) return it.reading.trim().split(/\s+/)[0];
  const front = it.term.trim();
  if (ipa.test(front)) return firstAlt(it.back);
  // A Latin front in a non-Latin script is a romanization: say its answer.
  if (latin.test(front) && !["fr", "es", "de", "en", "it", "pt"].includes(lang))
    return firstAlt(it.back);
  return firstAlt(front);
}
