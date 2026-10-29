/**
 * Anki notes → word-list entries (/words/import). Pure: no DOM, no I/O, so the
 * whole mapping is unit tested (unit/words-anki.test.ts).
 *
 * A note is a list of fields; a word list wants term / back / reading /
 * example / example translation. Which field is which is guessed from the
 * field names (Front/Back, Expression/Meaning/Reading, Word/Definition/
 * Sentence…) and the user can change it. Field text is Anki HTML: tags, media
 * references, cloze and furigana markup are reduced to plain text — word
 * lists are text only.
 */

/** One entry of an imported list, as stored server-side (word_list_entries). */
export type ImportEntry = {
  /** Anki note guid: stable across exports, so a re-import updates in place. */
  key: string;
  term: string;
  back: string;
  reading?: string;
  ex?: string;
  exTr?: string;
};

export const ROLES = ["term", "back", "reading", "ex", "exTr"] as const;
export type Role = (typeof ROLES)[number];
/** Field index per role; -1 = not used. */
export type FieldMapping = Record<Role, number>;

/** Longest term, back and example kept (the /known route takes terms ≤ 200). */
export const MAX_LEN: Record<Role, number> = {
  term: 200,
  back: 1000,
  reading: 200,
  ex: 500,
  exTr: 500,
};
/** Most entries one imported list may hold. */
export const MAX_ENTRIES = 20_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const hasImage = (field: string) => /<img\b/i.test(field);
export const hasSound = (field: string) => /\[sound:[^\]]*\]/i.test(field);

/**
 * Anki field HTML → one line of plain text. Line breaks become `sep`
 * (a word's meanings often sit on separate lines).
 */
export function stripAnki(field: string, sep = "; "): string {
  let s = field
    .replace(/\[sound:[^\]]*\]/gi, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    // Ruby annotations: the base text stays, the reading goes.
    .replace(/<(rt|rp)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*>/gi, " ")
    // Cloze: {{c1::answer::hint}} → answer
    .replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, "$1")
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(sep)
    .trim();
}

// Anki's furigana syntax: "日本[にほん]語[ご]" (a space may separate groups).
const FURIGANA = / ?([^ [\]>]+?)\[([^\]]+)\]/g;
export const hasFurigana = (s: string) => /[^ [\]]\[[^\]]+\]/.test(s);
/** The text without its furigana: 日本[にほん] → 日本. */
export const furiganaBase = (s: string) => s.replace(FURIGANA, "$1");
/** The reading: 日本[にほん]語 → にほん語. */
export const furiganaKana = (s: string) => s.replace(FURIGANA, "$2");

const ROLE_NAMES: Record<Role, RegExp> = {
  term: /^(front|expression|word|vocab(ulary)?|term|kanji|hanzi|simplified|target|question|headword|lemma|text|key)\b/i,
  back: /^(back|meaning|meanings|definition|definitions|english|translation|answer|gloss|glossary|sense)\b/i,
  reading:
    /^(reading|kana|furigana|hiragana|pinyin|pronunciation|romaji|romanization|ipa|transliteration)\b/i,
  ex: /^(sentence|example|examples|context)\b/i,
  exTr: /^(sentence|example|context)[ _-]?(translation|meaning|english|en|eng|tr)\b|^(translated|english)[ _-]?(sentence|example)/i,
};
/** Fields that never hold text: media and bookkeeping. */
const NOT_TEXT =
  /(audio|sound|image|picture|pic|photo|video|media|tags?|notes?|frequency|freq|rank|id)$/i;

/**
 * A role → field mapping from the field names: names first (Expression,
 * Meaning, Reading…), else the first two text fields are front and back.
 */
export function guessMapping(fields: string[]): FieldMapping {
  const m: FieldMapping = { term: -1, back: -1, reading: -1, ex: -1, exTr: -1 };
  const taken = new Set<number>();
  const pick = (role: Role) => {
    // The whole name, or its last part: "Vocabulary-Furigana" is a reading.
    const named = (f: string) =>
      ROLE_NAMES[role].test(f) || ROLE_NAMES[role].test(f.split(/[-_:.\s]+/).pop() ?? "");
    const i = fields.findIndex(
      (f, i) => !taken.has(i) && !NOT_TEXT.test(f.trim()) && named(f.trim()),
    );
    if (i >= 0) {
      m[role] = i;
      taken.add(i);
    }
  };
  // exTr before ex: "Sentence translation" must not be taken as the sentence.
  for (const role of ["exTr", "term", "back", "reading", "ex"] as const) pick(role);
  const free = () => fields.findIndex((f, i) => !taken.has(i) && !NOT_TEXT.test(f.trim()));
  for (const role of ["term", "back"] as const)
    if (m[role] < 0) {
      const i = free();
      if (i >= 0) {
        m[role] = i;
        taken.add(i);
      }
    }
  return m;
}

/**
 * The same mapping for a note type with other fields: by field name where
 * the names match, else by position.
 */
export function remapByName(mapping: FieldMapping, from: string[], to: string[]): FieldMapping {
  const out = { ...mapping };
  for (const role of ROLES) {
    const i = mapping[role];
    if (i < 0) continue;
    const byName = to.findIndex((f) => f.toLowerCase() === from[i]?.toLowerCase());
    out[role] = byName >= 0 ? byName : i < to.length ? i : -1;
  }
  return out;
}

export type NoteInput = { guid: string; fields: string[]; mapping: FieldMapping };

export type BuildResult = {
  entries: ImportEntry[];
  /** Notes whose front had no text (an image or audio-only card). */
  empty: number;
  /** Notes whose term was already in the list from an earlier note. */
  duplicates: number;
  /** Notes with at least one image (dropped: word lists are text only). */
  images: number;
  /** Notes with audio (dropped: Lianki speaks words itself). */
  sounds: number;
  /** Notes left out over MAX_ENTRIES. */
  over: number;
};

const clip = (s: string, role: Role) =>
  s.length > MAX_LEN[role] ? s.slice(0, MAX_LEN[role] - 1) + "…" : s;

/** Notes → entries, in note order; the first note of a term wins. */
export function buildEntries(notes: NoteInput[], max = MAX_ENTRIES): BuildResult {
  const out: BuildResult = { entries: [], empty: 0, duplicates: 0, images: 0, sounds: 0, over: 0 };
  const seen = new Set<string>();
  for (const n of notes) {
    if (n.fields.some(hasImage)) out.images++;
    if (n.fields.some(hasSound)) out.sounds++;
    const raw = (role: Role) => {
      const i = n.mapping[role];
      return i >= 0 && i < n.fields.length ? stripAnki(n.fields[i]) : "";
    };
    let term = raw("term");
    let reading = raw("reading");
    if (hasFurigana(term)) {
      if (!reading) reading = furiganaKana(term);
      term = furiganaBase(term);
    }
    if (hasFurigana(reading)) reading = furiganaKana(reading);
    term = term.replace(/\s+/g, " ").trim();
    if (!term) {
      out.empty++;
      continue;
    }
    term = clip(term, "term");
    if (seen.has(term)) {
      out.duplicates++;
      continue;
    }
    if (out.entries.length >= max) {
      out.over++;
      continue;
    }
    seen.add(term);
    const e: ImportEntry = { key: n.guid, term, back: clip(raw("back"), "back") };
    if (reading && reading !== term) e.reading = clip(reading, "reading");
    const ex = furiganaBase(raw("ex"));
    if (ex) e.ex = clip(ex, "ex");
    const exTr = raw("exTr");
    if (exTr) e.exTr = clip(exTr, "exTr");
    out.entries.push(e);
  }
  return out;
}

/** Languages offered for an imported list (BCP 47 base codes). */
export const IMPORT_LANGS = [
  "ja",
  "zh",
  "ko",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ru",
  "ar",
  "hi",
  "bn",
  "ur",
  "id",
  "sw",
  "mr",
  "nl",
  "sv",
  "no",
  "da",
  "fi",
  "pl",
  "cs",
  "tr",
  "uk",
  "el",
  "he",
  "fa",
  "th",
  "vi",
  "la",
] as const;

const NAME_HINTS: [RegExp, string][] = [
  [/japan|日本|nihongo|jlpt|kanji|kana|core ?[26]k/i, "ja"],
  [/chinese|mandarin|cantonese|中文|汉语|漢語|hsk|pinyin/i, "zh"],
  [/korean|한국|topik|hangul/i, "ko"],
  [/spanish|español|espanol/i, "es"],
  [/french|français|francais/i, "fr"],
  [/german|deutsch/i, "de"],
  [/italian|italiano/i, "it"],
  [/portugu/i, "pt"],
  [/russian|русск/i, "ru"],
  [/arabic|عربي/i, "ar"],
  [/hindi|हिन्दी|हिंदी/i, "hi"],
  [/dutch|nederlands/i, "nl"],
  [/swedish|svenska/i, "sv"],
  [/polish|polski/i, "pl"],
  [/turkish|türkçe/i, "tr"],
  [/greek|ελλην/i, "el"],
  [/hebrew|עברית/i, "he"],
  [/vietnam|tiếng việt/i, "vi"],
  [/thai|ภาษาไทย/i, "th"],
  [/latin/i, "la"],
  [/indonesia/i, "id"],
  [/swahili/i, "sw"],
  [/ukrain/i, "uk"],
  [/persian|farsi/i, "fa"],
  [/english|toefl|ielts|gre\b|sat\b/i, "en"],
];

/**
 * Best guess at the language of a deck's terms: its name first ("Spanish Top
 * 5000"), then the script of the terms themselves.
 */
export function guessLang(deckName: string, terms: string[]): string {
  for (const [re, lang] of NAME_HINTS) if (re.test(deckName)) return lang;
  const text = terms.slice(0, 300).join(" ");
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  if (count(/[぀-ヿ]/g) > 0) return "ja";
  const scripts: [RegExp, string][] = [
    [/[一-鿿]/g, "zh"],
    [/[가-힯ᄀ-ᇿ]/g, "ko"],
    [/[Ѐ-ӿ]/g, "ru"],
    [/[؀-ۿ]/g, "ar"],
    [/[ऀ-ॿ]/g, "hi"],
    [/[ঀ-৿]/g, "bn"],
    [/[฀-๿]/g, "th"],
    [/[Ͱ-Ͽ]/g, "el"],
    [/[֐-׿]/g, "he"],
  ];
  let best = { lang: "", n: 0 };
  for (const [re, lang] of scripts) {
    const n = count(re);
    if (n > best.n) best = { lang, n };
  }
  if (best.n > 0) return best.lang;
  // Latin script: the language's own letters give it away.
  const latin: [RegExp, string][] = [
    [/[ñ¿¡]/gi, "es"],
    [/[ãõ]/gi, "pt"],
    [/[ßäöü]/gi, "de"],
    [/[çœèêëàâîïôûù]/gi, "fr"],
    [/[ąćęłńśźż]/gi, "pl"],
    [/[ğışİ]/g, "tr"],
    [/[ăâđêôơư]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi, "vi"],
    [/[åø]/gi, "no"],
  ];
  best = { lang: "", n: 0 };
  for (const [re, lang] of latin) {
    const n = count(re);
    if (n > best.n) best = { lang, n };
  }
  return best.n > 0 ? best.lang : "en";
}
