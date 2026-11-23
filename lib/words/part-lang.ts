/**
 * Which language each stretch of a spoken part is in, from its script.
 *
 * A line read aloud may mix languages — an imported deck's example field
 * often carries the sentence and its translation together ("I like apples.
 * 我喜欢苹果。"). Sent as one utterance in the card's language, an English
 * voice read the Chinese (owner, 2026-11-21). So every part is split into
 * same-language runs and each run names its own language; the voice for a
 * run (server, browser or recording) is then chosen from that run alone.
 *
 * One generic engine, the rules as data: SCRIPTS names the scripts,
 * SCRIPT_LANG the language a run of a script is read in, LANG_SCRIPT the
 * script of a card's language. No language has code of its own.
 */

/** A writing system a character belongs to. "cjk": Han and kana together (a Japanese sentence mixes both). */
type Script =
  | "cjk"
  | "hangul"
  | "cyrillic"
  | "arabic"
  | "devanagari"
  | "bengali"
  | "thai"
  | "greek"
  | "hebrew"
  | "latin";

/** Letters of each script, tried in order. Anything else (spaces, digits, punctuation) is neutral. */
const SCRIPTS: readonly (readonly [RegExp, Script])[] = [
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

/** The language a run of a script is read in when the card's language is of another script. */
const SCRIPT_LANG: Record<Exclude<Script, "cjk" | "latin">, string> = {
  hangul: "ko",
  cyrillic: "ru",
  arabic: "ar",
  devanagari: "hi",
  bengali: "bn",
  thai: "th",
  greek: "el",
  hebrew: "he",
};

/** The script of a language (its primary subtag); any language not listed is written in Latin. */
const LANG_SCRIPT: Record<string, Script> = {
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

/** Kana: only Japanese writes it. */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Where a sentence ends: a Han-only sentence next to a Japanese one is decided on its own. */
const SENTENCE_END = /[。！？!?\n]/;
/** A Latin run that ends a sentence or a bracket is a sentence of its own, not a word inside another. */
const LATIN_SENTENCE = /[.!?…)）\]]["'”’»]*$/;

const primary = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
export const scriptOfLang = (lang: string): Script => LANG_SCRIPT[primary(lang)] ?? "latin";

function scriptOf(ch: string): Script | null {
  for (const [re, s] of SCRIPTS) if (re.test(ch)) return s;
  return null;
}

export type LangRun = { text: string; lang: string };

export type RunOptions = {
  /** The UI's locale: settles Han text when the base language is of another script (日本語 UI → ja). */
  uiLocale?: string;
  /** What Latin text is read in when the base language is not written in Latin. */
  latinLang?: string;
};

/** The language of one run of `script`, `hasKana` telling a Japanese CJK run from a Chinese one. */
function runLang(script: Script, hasKana: boolean, base: string, o: RunOptions): string {
  if (script === scriptOfLang(base)) {
    // A Chinese card's Japanese line (kana) is still Japanese.
    if (script === "cjk" && hasKana && primary(base) !== "ja") return "ja";
    return base;
  }
  if (script === "latin") return o.latinLang ?? "en";
  if (script === "cjk") {
    if (hasKana) return "ja";
    const ui = o.uiLocale ?? "";
    return scriptOfLang(ui) === "cjk" ? primary(ui) : "zh";
  }
  return SCRIPT_LANG[script];
}

type Raw = { text: string; script: Script | null };

/**
 * `text` as same-language runs, in order; each run's text is what to say.
 * `base`: the language the line is meant to be in (the card's). Text of
 * another script always becomes its own run — a voice of one script cannot
 * read another's. Latin words inside a line of a non-Latin language (a brand
 * name in a Chinese sentence) stay in it; a Latin sentence there is its own run.
 */
export function langRuns(text: string, base: string, o: RunOptions = {}): LangRun[] {
  // 1. Script runs; neutral characters join the run before them (or the first one).
  const raw: Raw[] = [];
  let lead = "";
  for (const ch of text) {
    const s = scriptOf(ch);
    const last = raw.at(-1);
    if (s === null) {
      if (last) last.text += ch;
      else lead += ch;
      // A CJK sentence ends here: the next one is decided on its own.
      if (last?.script === "cjk" && SENTENCE_END.test(ch)) raw.push({ text: "", script: null });
      continue;
    }
    if (last && (last.script === s || last.script === null)) {
      last.text += ch;
      last.script = s;
    } else raw.push({ text: lead + ch, script: s });
    lead = "";
  }
  if (raw.length === 0) return [];
  // 2. In a line of a non-Latin language, Latin words that are not a sentence join their neighbour.
  const foldLatin = scriptOfLang(base) !== "latin";
  const runs: { text: string; lang: string; script: Script }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r.script === null) {
      // An empty sentence break with only neutral text after it.
      if (runs.length) runs[runs.length - 1].text += r.text;
      continue;
    }
    const lang = runLang(r.script, KANA.test(r.text), base, o);
    const folds =
      foldLatin && r.script === "latin" && !LATIN_SENTENCE.test(r.text.trim()) && raw.length > 1;
    const prev = runs.at(-1);
    if (folds && prev) {
      prev.text += r.text;
      continue;
    }
    if (folds) {
      // Latin first: it joins the next run of a script that is not Latin.
      const next = raw.slice(i + 1).find((x) => x.script !== null && x.script !== "latin");
      if (next) {
        next.text = r.text + next.text;
        continue;
      }
    }
    // 3. Neighbours in the same language are one run.
    if (prev && prev.lang === lang) prev.text += r.text;
    else runs.push({ text: r.text, lang, script: r.script });
  }
  return runs.map((r) => ({ text: r.text.trim(), lang: r.lang })).filter((r) => r.text);
}

/**
 * The language of a whole text, from its script: a script other than Latin
 * wins (its longest run), as a Latin voice could not read it at all. Latin
 * text is English (`latinLang`), Han the UI's CJK language or Chinese.
 */
export function textLang(text: string, o: RunOptions = {}): string {
  const latin = o.latinLang ?? "en";
  let best: LangRun | undefined;
  for (const r of langRuns(text, latin, o))
    if (r.lang !== latin && (!best || r.text.length > best.text.length)) best = r;
  return best?.lang ?? latin;
}
