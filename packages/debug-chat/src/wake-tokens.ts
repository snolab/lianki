/**
 * Names → the wake-word model's tokens (docs/wake-word.md, "Names as wake
 * words"). kws-zipformer-zh-en-3M-2025-12-20 takes keywords as its own
 * tokens, never as text: CMU phones with stress for English ("coco" →
 * K OW1 K OW2), and for Chinese a pinyin initial plus its toned final per
 * syllable (杰咪 → j ié m ī), as in the model's own keywords.txt.
 *
 * - Chinese characters: their most common reading (wake-lexicon.ts
 *   PINYIN_TABLE, about 3,800 characters).
 * - Latin words: the CMU dictionary entry for known names (EN_NAMES), else
 *   simple letter-to-sound rules (`lettersToPhones`). A wrong guess only
 *   makes that name harder to wake on; it never wakes on anything else more.
 * - Anything else (kana, digits, emoji, a character not in the table): the
 *   name cannot be said to the spotter and is skipped (`nameTokens` → null).
 *
 * Pure, tested in unit/wake-names.test.ts.
 */
import { EN_NAMES, KWS_TOKEN_LIST, PINYIN_TABLE } from "./wake-lexicon";

/** Every token the model knows; a keyword with any other is refused by the spotter. */
export const KWS_TOKENS: ReadonlySet<string> = new Set(KWS_TOKEN_LIST.split(" "));

let hanzi: Map<string, string> | null = null;
/** A character's toned pinyin ("杰" → "jié"), or undefined. */
export function pinyinOf(ch: string): string | undefined {
  if (!hanzi) {
    hanzi = new Map();
    for (const group of PINYIN_TABLE.split(" ")) {
      const i = group.indexOf(":");
      for (const c of group.slice(i + 1)) if (!hanzi.has(c)) hanzi.set(c, group.slice(0, i));
    }
  }
  return hanzi.get(ch);
}

/** Pinyin initials, longest first; y and w count as initials, as the model has them. */
const INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];

/** One toned syllable → its tokens ("jié" → ["j", "ié"], "ér" → ["ér"]), or null if the model lacks one. */
export function syllableTokens(syl: string): string[] | null {
  const s = syl.normalize("NFC").toLowerCase();
  if (!s) return null;
  const ini = INITIALS.find((i) => s.startsWith(i) && s.length > i.length);
  const out = ini ? [ini, s.slice(ini.length)] : [s];
  return out.every((t) => KWS_TOKENS.has(t)) ? out : null;
}

let en: Map<string, string[]> | null = null;
/** A known name's CMU phones ("coco" → K OW1 K OW2), or undefined. */
export function cmuOf(word: string): string[] | undefined {
  if (!en) {
    en = new Map();
    for (const e of EN_NAMES.split(" ")) {
      const i = e.indexOf(":");
      en.set(e.slice(0, i), e.slice(i + 1).split("."));
    }
  }
  return en.get(word.toLowerCase());
}

const VOWEL = /[aeiouy]/;
/** Letter groups to phones, tried longest first. `V` = a vowel sound (stress added later). */
const GROUPS: [string, string[]][] = [
  ["tch", ["CH"]],
  ["sch", ["SH"]],
  ["igh", ["V:AY"]],
  ["ch", ["CH"]],
  ["sh", ["SH"]],
  ["th", ["TH"]],
  ["ph", ["F"]],
  ["wh", ["W"]],
  ["ck", ["K"]],
  ["qu", ["K", "W"]],
  ["ng", ["NG"]],
  ["ee", ["V:IY"]],
  ["ea", ["V:IY"]],
  ["ie", ["V:IY"]],
  ["oo", ["V:UW"]],
  ["ou", ["V:AW"]],
  ["ow", ["V:OW"]],
  ["oi", ["V:OY"]],
  ["oy", ["V:OY"]],
  ["ai", ["V:EY"]],
  ["ay", ["V:EY"]],
  ["ei", ["V:EY"]],
  ["ey", ["V:EY"]],
  ["au", ["V:AO"]],
  ["aw", ["V:AO"]],
  ["oa", ["V:OW"]],
  ["ue", ["V:UW"]],
  ["ui", ["V:UW"]],
  ["ar", ["V:AA", "R"]],
  ["er", ["V:ER"]],
  ["ir", ["V:ER"]],
  ["ur", ["V:ER"]],
  ["or", ["V:AO", "R"]],
];
const SINGLE: Record<string, string[]> = {
  b: ["B"],
  d: ["D"],
  f: ["F"],
  h: ["HH"],
  j: ["JH"],
  k: ["K"],
  l: ["L"],
  m: ["M"],
  n: ["N"],
  p: ["P"],
  q: ["K"],
  r: ["R"],
  s: ["S"],
  t: ["T"],
  v: ["V"],
  w: ["W"],
  x: ["K", "S"],
  z: ["Z"],
};
/** A vowel letter: short when a consonant cluster or the end closes it, long when open ("momo", "yuki"). */
const SHORT: Record<string, string> = { a: "AE", e: "EH", i: "IH", o: "AA", u: "AH", y: "IH" };
const LONG: Record<string, string> = { a: "EY", e: "IY", i: "AY", o: "OW", u: "UW", y: "AY" };
const OPEN: Record<string, string> = { a: "AA", e: "EY", i: "IY", o: "OW", u: "UW", y: "IY" };
const FINAL: Record<string, string> = { a: "AH", e: "IY", i: "IY", o: "OW", u: "UW", y: "IY" };

/**
 * English letter-to-sound for a name not in the dictionary: a rough guess in
 * CMU phones, the first vowel stressed. Returns null for a word with no letters.
 */
export function lettersToPhones(word: string): string[] | null {
  const w = word.toLowerCase().replace(/[^a-z]/g, "").replace(/([b-df-hj-np-tv-z])\1+/g, "$1");
  if (!w) return null;
  const out: string[] = [];
  let i = 0;
  // "kn", "wr", "gn" at the start: the first letter is silent.
  if (/^(kn|wr|gn)/.test(w)) i = 1;
  while (i < w.length) {
    const rest = w.slice(i);
    const g = GROUPS.find(([k]) => rest.startsWith(k));
    if (g) {
      out.push(...g[1]);
      i += g[0].length;
      continue;
    }
    const c = w[i]!;
    const next = w[i + 1];
    const end = i === w.length - 1;
    if (c === "y" && i === 0 && next && VOWEL.test(next)) {
      out.push("Y");
      i++;
      continue;
    }
    if (VOWEL.test(c)) {
      const hasVowel = out.some((p) => p.startsWith("V:"));
      if (c === "e" && end && hasVowel) break; // a silent final e
      if (end) out.push(`V:${FINAL[c]}`);
      else if (/^[b-df-hj-np-tv-z]e$/.test(w.slice(i + 1)) && c !== "e") out.push(`V:${LONG[c]}`); // magic e: "mike"
      else if (next && /[b-df-hj-np-tv-z]/.test(next) && w[i + 2] && VOWEL.test(w[i + 2]!))
        out.push(`V:${OPEN[c]}`);
      else out.push(`V:${SHORT[c]}`);
      i++;
      continue;
    }
    if (c === "c") out.push(next && /[eiy]/.test(next) ? "S" : "K");
    else if (c === "g") out.push(next && /[eiy]/.test(next) ? "JH" : "G");
    else out.push(...(SINGLE[c] ?? []));
    i++;
  }
  let stressed = false;
  const phones = out.map((p) => {
    if (!p.startsWith("V:")) return p;
    const v = p.slice(2);
    const s = stressed ? "0" : "1";
    stressed = true;
    return `${v}${s}`;
  });
  return phones.length && phones.every((p) => KWS_TOKENS.has(p)) ? phones : null;
}

/** Each letter's name in CMU phones ("GPT" is said G-P-T). */
const LETTER_NAMES: Record<string, string> = {
  a: "EY1",
  b: "B IY1",
  c: "S IY1",
  d: "D IY1",
  e: "IY1",
  f: "EH1 F",
  g: "JH IY1",
  h: "EY1 CH",
  i: "AY1",
  j: "JH EY1",
  k: "K EY1",
  l: "EH1 L",
  m: "EH1 M",
  n: "EH1 N",
  o: "OW1",
  p: "P IY1",
  q: "K Y UW1",
  r: "AA1 R",
  s: "EH1 S",
  t: "T IY1",
  u: "Y UW1",
  v: "V IY1",
  w: "D AH1 B AH0 L Y UW0",
  x: "EH1 K S",
  y: "W AY1",
  z: "Z IY1",
};
/** A word spelled out letter by letter. */
export function spellOut(word: string): string[] {
  return [...word.toLowerCase()].flatMap((c) => LETTER_NAMES[c]?.split(" ") ?? []);
}

/**
 * One Latin word → phones: the dictionary, else spelled out when it is an
 * initialism (no vowel letter, or 2–4 capitals: "mcp", "GPT"), else the rules.
 */
export function wordPhones(word: string): string[] | null {
  const known = cmuOf(word);
  if (known) return known;
  if (!/[aeiouy]/i.test(word) || /^[A-Z]{2,4}$/.test(word)) return spellOut(word);
  return lettersToPhones(word);
}

const HAN = /\p{Script=Han}/u;
const LATIN = /[a-z]/i;
/** What may sit between words and is not said: spaces, dots, hyphens, ·, apostrophes. */
const SEP = /[\s.\-_·'’,，、]/u;

/**
 * A name → its tokens, or null when any part of it cannot be said to the
 * spotter (another script, a digit, a rare character). Chinese and Latin
 * may mix ("Lin琪"); separators are dropped.
 */
export function nameTokens(name: string): string[] | null {
  const s = name.normalize("NFC").trim();
  if (!s) return null;
  const out: string[] = [];
  let word = "";
  const flush = () => {
    if (!word) return true;
    const p = wordPhones(word);
    word = "";
    if (!p) return false;
    out.push(...p);
    return true;
  };
  for (const ch of s) {
    if (LATIN.test(ch) && ch.length === 1 && ch.charCodeAt(0) < 128) {
      word += ch;
      continue;
    }
    if (!flush()) return null;
    if (SEP.test(ch)) continue;
    if (!HAN.test(ch)) return null;
    const py = pinyinOf(ch);
    const t = py ? syllableTokens(py) : null;
    if (!t) return null;
    out.push(...t);
  }
  if (!flush()) return null;
  return out.length ? out : null;
}

/** A token with its stress digit or tone mark taken off: what "sounds the same" compares. */
export function plainToken(t: string): string {
  return t
    .replace(/[012]$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC");
}

/** A pinyin final without its tone mark (ü keeps its dots): "iǎo" → "iao", "ǚ" → "ü". */
export function toneless(t: string): string {
  return t.normalize("NFD").replace(/[̀́̄̌]/g, "").normalize("NFC");
}

let byTone: Map<string, string[]> | null = null;
/** The model's finals that are `t` in any tone (the toneless one too), `t` first. */
function tonesOf(t: string): string[] {
  if (!byTone) {
    byTone = new Map();
    for (const k of KWS_TOKENS) {
      if (!/^[a-zǜ-ͯÀ-ɏ]+$/u.test(k.normalize("NFC")) || INITIALS.includes(k)) continue;
      const base = toneless(k);
      byTone.set(base, [...(byTone.get(base) ?? []), k]);
    }
  }
  const all = byTone.get(toneless(t)) ?? [t];
  return [t, ...all.filter((x) => x !== t)];
}

/** At most this many tone readings of one spelling (two syllables in every tone fit). */
export const MAX_TONE_VARIANTS = 25;

/**
 * Every tone reading of a Chinese name's tokens (杰咪 j ié m ī → … j ié m ǐ,
 * j iě m ì …), the spelling's own first. The model has a token per toned
 * final, so 杰咪 said as jié mǐ (STT: 杰米) or jiě mì (解密) never matches
 * j ié m ī; tones drift in speech, so a name wakes in any of them. Latin
 * (CMU) tokens are kept as they are. Capped at MAX_TONE_VARIANTS: past it,
 * the spelling alone.
 */
export function toneVariants(tokens: readonly string[]): string[][] {
  const choices = tokens.map((t) => (/^[A-Z]/.test(t) || INITIALS.includes(t) ? [t] : tonesOf(t)));
  const n = choices.reduce((p, c) => p * c.length, 1);
  if (n > MAX_TONE_VARIANTS) return [[...tokens]];
  let out: string[][] = [[]];
  for (const c of choices) out = out.flatMap((p) => c.map((t) => [...p, t]));
  return out;
}
