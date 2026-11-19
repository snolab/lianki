/**
 * Lane names by sound (owner, 2026-11-15 22:35 JST: "我还是希望从语音层面来").
 * STT writes 杰咪 as 杰米, 解密, 切咪…; instead of listing every spelling,
 * a run of Han characters whose toneless pinyin matches a name's syllables is
 * that name. Each syllable must be equal or near: the same final with a
 * confusable initial (j/q/x, zh/z…), or the same initial with a confusable
 * final (in/ing, an/ang…). At most `maxNear` near syllables per name
 * (config `lanes.phoneticMaxNear`, 0 = the same pinyin only).
 *
 * The confusable sets are DATA (INITIAL_NEAR, FINAL_NEAR), one generic
 * engine reads them. Latin names are not matched here: their spellings stay
 * text (lane-route.ts). Names shorter than MIN_SYLLABLES are never matched by
 * sound: one syllable is too common a sound to be a name.
 *
 * The pinyin reader is handed in (lane-route.ts passes wake-tokens.ts
 * pinyinOf), so this module stays light: lib/config.ts reads its default.
 *
 * Pure, tested in unit/lane-phonetic.test.ts.
 */

/** Initials heard for one another (southern accents, fast speech, STT). */
export const INITIAL_NEAR: readonly (readonly string[])[] = [
  ["j", "q", "x"],
  ["zh", "z"],
  ["ch", "c"],
  ["sh", "s"],
  ["n", "l"],
];

/** Finals heard for one another: front/back nasals, and ie said as i. */
export const FINAL_NEAR: readonly (readonly string[])[] = [
  ["in", "ing"],
  ["en", "eng"],
  ["an", "ang"],
  ["ian", "iang"],
  ["uan", "uang"],
  ["ie", "i"],
];

/** Default of config `lanes.phoneticMaxNear`: near syllables allowed per name. */
export const PHONETIC_MAX_NEAR_DEFAULT = 1;
/** The cap's range (lib/config.ts bounds). */
export const PHONETIC_MAX_NEAR_MAX = 3;
/** A name matched by sound has at least this many syllables. */
export const MIN_SYLLABLES = 2;

let maxNear = PHONETIC_MAX_NEAR_DEFAULT;
/** Put config `lanes.phoneticMaxNear` in force (a bad value keeps the current one). */
export function setPhoneticMaxNear(n: unknown): number {
  if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= PHONETIC_MAX_NEAR_MAX)
    maxNear = n;
  return maxNear;
}
export const phoneticMaxNear = () => maxNear;

/** Pinyin initials, longest first (y and w as initials, like wake-tokens.ts). */
const INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];

/** "jie" → ["j", "ie"], "er" → ["", "er"]. */
export function splitSyllable(syl: string): [string, string] {
  const ini = INITIALS.find((i) => syl.startsWith(i) && syl.length > i.length) ?? "";
  return [ini, syl.slice(ini.length)];
}

const groupOf = (table: readonly (readonly string[])[]) => {
  const m = new Map<string, number>();
  table.forEach((g, i) => g.forEach((x) => m.set(x, i)));
  return m;
};
const INI_GROUP = groupOf(INITIAL_NEAR);
const FIN_GROUP = groupOf(FINAL_NEAR);
const sameGroup = (m: Map<string, number>, a: string, b: string) =>
  m.has(a) && m.get(a) === m.get(b);

/** How two toneless syllables compare: "same", "near" (one confusable part), or null. */
export function compareSyllables(a: string, b: string): "same" | "near" | null {
  if (a === b) return "same";
  const [ia, fa] = splitSyllable(a);
  const [ib, fb] = splitSyllable(b);
  if (fa === fb && sameGroup(INI_GROUP, ia, ib)) return "near";
  if (ia === ib && sameGroup(FIN_GROUP, fa, fb)) return "near";
  return null;
}

/** A character's toned pinyin ("杰" → "jié"), or undefined. */
export type PinyinOf = (ch: string) => string | undefined;

/** A pinyin syllable without its tone mark (ü keeps its dots): "jié" → "jie". */
export const toneless = (s: string) =>
  s.normalize("NFD").replace(/[̀́̄̌]/g, "").normalize("NFC").toLowerCase();

const HAN = /^\p{Script=Han}$/u;

/** A name's toneless syllables, when every character of it is a Han character with a reading; else null. */
export function nameSyllables(name: string, pinyinOf: PinyinOf): string[] | null {
  const out: string[] = [];
  for (const ch of name) {
    const py = HAN.test(ch) ? pinyinOf(ch) : undefined;
    if (!py) return null;
    out.push(toneless(py));
  }
  return out.length >= MIN_SYLLABLES ? out : null;
}

/**
 * Whether `s` starts with a name said as `syls`: the end (in UTF-16 units)
 * of the matching characters, or -1. Each character must be Han with a
 * reading, equal or near its syllable, with at most `cap` near ones.
 */
export function phoneticPrefix(
  s: string,
  syls: readonly string[],
  pinyinOf: PinyinOf,
  cap: number = maxNear,
): number {
  let end = 0;
  let near = 0;
  const chars = s[Symbol.iterator]();
  for (const want of syls) {
    const { value: ch, done } = chars.next();
    if (done || !HAN.test(ch)) return -1;
    const py = pinyinOf(ch);
    if (!py) return -1;
    const c = compareSyllables(toneless(py), want);
    if (!c) return -1;
    if (c === "near" && ++near > cap) return -1;
    end += ch.length;
  }
  return end;
}
