/**
 * Parenthesized translations left out of what is read aloud.
 *
 * Imported lists (OCR word books) put a translation in brackets after the
 * example: "I like apples. (我喜欢苹果。)". Read whole in the card's language,
 * an English voice mangled the Chinese (owner, 2026-11-25: 括号里头的中文一律不念).
 * So a bracketed stretch — ( … ) or full-width （ … ） — whose letters are
 * mainly of another script than the card's language is not spoken; it still
 * shows on screen. Same-script notes such as "(informal)" are read as before.
 *
 * One generic engine, the rules as data: SCRIPTS names the scripts,
 * LANG_SCRIPT the script a language is written in. No language has code of
 * its own. Config: `words.speak.skipForeignParens` (lib/config.ts).
 */

/** A stretch of the text, [start, end) in UTF-16 units. */
export type Cut = readonly [number, number];

/** Letters of each script; anything else (spaces, digits, punctuation) counts for none. "cjk": Han and kana together. */
const SCRIPTS: readonly (readonly [RegExp, string])[] = [
  [/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, "cjk"],
  [/\p{Script=Hangul}/u, "hangul"],
  [/\p{Script=Cyrillic}/u, "cyrillic"],
  [/\p{Script=Arabic}/u, "arabic"],
  [/\p{Script=Devanagari}/u, "devanagari"],
  [/\p{Script=Bengali}/u, "bengali"],
  [/\p{Script=Thai}/u, "thai"],
  [/\p{Script=Greek}/u, "greek"],
  [/\p{Script=Hebrew}/u, "hebrew"],
  [/\p{Script=Latin}/u, "latin"],
];

/** The script of a language (its primary subtag); a language not listed is written in Latin. */
const LANG_SCRIPT: Record<string, string> = {
  ja: "cjk",
  zh: "cjk",
  yue: "cjk",
  ko: "hangul",
  ru: "cyrillic",
  uk: "cyrillic",
  bg: "cyrillic",
  sr: "cyrillic",
  mk: "cyrillic",
  be: "cyrillic",
  kk: "cyrillic",
  mn: "cyrillic",
  ar: "arabic",
  fa: "arabic",
  ur: "arabic",
  hi: "devanagari",
  mr: "devanagari",
  ne: "devanagari",
  bn: "bengali",
  th: "thai",
  el: "greek",
  he: "hebrew",
  yi: "hebrew",
};

const OPEN = new Set(["(", "（"]);
const CLOSE = new Set([")", "）"]);

const scriptOfLang = (lang: string) => LANG_SCRIPT[lang.toLowerCase().split(/[-_]/)[0]] ?? "latin";

function scriptOf(ch: string): string | null {
  for (const [re, s] of SCRIPTS) if (re.test(ch)) return s;
  return null;
}

/** The script most of the letters of `text` are in, or null for none (digits, punctuation). */
function mainScript(text: string): string | null {
  const n = new Map<string, number>();
  for (const ch of text) {
    const s = scriptOf(ch);
    if (s) n.set(s, (n.get(s) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  for (const [s, c] of n) if (c > most) [best, most] = [s, c];
  return best;
}

/**
 * Outermost bracket groups of `text`, each [open, close + 1). Either kind of
 * bracket closes either (OCR mixes them); an unclosed group and a stray
 * closing bracket are plain text.
 */
function groups(text: string): Cut[] {
  const out: Cut[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (OPEN.has(ch)) {
      if (depth++ === 0) start = i;
    } else if (CLOSE.has(ch) && depth > 0) {
      if (--depth === 0) out.push([start, i + 1]);
    }
  }
  return out;
}

/**
 * `text` as spoken in `lang`: bracketed stretches mainly of another script
 * left out, with the space before each. `cut`: the stretches removed, in
 * `text`'s offsets, for mapping the spoken text back onto the shown one.
 */
export function dropForeignParens(text: string, lang: string): { text: string; cut: Cut[] } {
  const own = scriptOfLang(lang);
  const cut: Cut[] = [];
  for (const [a, b] of groups(text)) {
    const s = mainScript(text.slice(a + 1, b - 1));
    if (!s || s === own) continue;
    let from = a;
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    // At the start, the space after goes instead.
    let to = b;
    if (from === 0) while (to < text.length && /\s/.test(text[to])) to++;
    cut.push([from, to]);
  }
  if (!cut.length) return { text, cut };
  let out = "";
  let at = 0;
  for (const [a, b] of cut) {
    out += text.slice(at, a);
    at = b;
  }
  return { text: out + text.slice(at), cut };
}

/** An offset in the spoken text (dropForeignParens' `text`) as an offset in the shown one. */
export function shownOffset(spoken: number, cut: readonly Cut[]): number {
  let o = spoken;
  for (const [a, b] of cut) {
    if (a > o) break;
    o += b - a;
  }
  return o;
}
