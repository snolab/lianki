/**
 * A plain word list (.txt, .csv, .tsv, or pasted text) → word-list entries
 * (docs/import-material.md, M1). Pure: no DOM, no I/O, so the whole mapping
 * is unit tested (unit/import-wordlist.test.ts). It runs in the browser for
 * the preview and again on the server, which trusts nothing the page sends.
 *
 * - One word per line, or rows of columns: the delimiter (tab, comma,
 *   semicolon) is sniffed from the first lines, and quoted CSV fields may
 *   hold delimiters, quotes and line breaks.
 * - A first row whose cells name columns (word / meaning / example…, in any
 *   of the languages listed in HEADER_ALIASES) is a header; without one the
 *   columns are term, meaning, example in that order.
 * - The page may send a column mapping (lib/import/column-map.ts): the
 *   fields each column fills, and whether the first row is a header. It
 *   decides over the detection; the server checks it like any input.
 * - Language rules are data: header names and list markers are tables, and
 *   the same normalization (NFC, folded spaces, lower case) serves every
 *   language. No branch looks at which language a list is in.
 */
import { MAX_ENTRIES, MAX_LEN, type ImportEntry, type Role } from "@/lib/words/anki";
import {
  cleanMapping,
  fromColumns,
  guessMapping,
  SLOTS,
  slotText,
  type ColumnMapping,
} from "@/lib/import/column-map";

/** Largest file or paste read, in bytes (UTF-8). A 20 000-word list with meanings fits. */
export const MAX_BYTES = 1_000_000;
/** Most words one import adds: as many as one imported list may hold. */
export const MAX_WORDS = MAX_ENTRIES;
/** Skipped lines listed by number in the preview (all are counted). */
const MAX_SKIP_LIST = 50;
/** Lines the delimiter sniff looks at. */
const SNIFF_LINES = 20;

export type Format = "lines" | "csv" | "tsv" | "ssv";
export type SkipReason = "no-term" | "too-long" | "duplicate" | "over-limit";

export type WordRow = {
  /** 1-based line of the row's start in the input. */
  line: number;
  term: string;
  back: string;
  reading?: string;
  ex?: string;
  exTr?: string;
};

export type ParsedWordList = {
  format: Format;
  header: boolean;
  /** Column index per role, as detected (-1 = none). */
  columns: Record<Role, number>;
  rows: WordRow[];
  skipped: { line: number; reason: SkipReason }[];
  skippedCount: number;
  /** Skipped rows per reason. */
  skippedBy: Record<SkipReason, number>;
};

export class WordListError extends Error {
  constructor(
    readonly code: "too-large" | "empty" | "binary",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Column names per role, compared after `headerKey` (lower case, no spaces
 * or punctuation). Data, not code: a language is added by adding its words.
 */
export const HEADER_ALIASES: Record<Role, readonly string[]> = {
  term: [
    "word",
    "words",
    "term",
    "front",
    "vocab",
    "vocabulary",
    "expression",
    "headword",
    "lemma",
    "kanji",
    "hanzi",
    "entry",
    "单词",
    "單詞",
    "词",
    "詞",
    "词语",
    "詞語",
    "生词",
    "生詞",
    "词汇",
    "詞彙",
    "単語",
    "語彙",
    "表記",
    "단어",
    "어휘",
    "palabra",
    "término",
    "termino",
    "mot",
    "terme",
    "wort",
    "begriff",
    "parola",
    "termine",
    "palavra",
    "termo",
    "слово",
    "термин",
    "كلمة",
    "शब्द",
    "শব্দ",
    "لفظ",
    "kata",
    "istilah",
    "neno",
    "woord",
    "ord",
    "słowo",
    "kelime",
    "từ",
    "λέξη",
    "מילה",
    "واژه",
    "คำ",
  ],
  back: [
    "meaning",
    "meanings",
    "definition",
    "definitions",
    "translation",
    "back",
    "gloss",
    "sense",
    "意思",
    "意义",
    "意義",
    "释义",
    "釋義",
    "含义",
    "含義",
    "翻译",
    "翻譯",
    "意味",
    "訳",
    "和訳",
    "뜻",
    "의미",
    "번역",
    "significado",
    "traducción",
    "traduccion",
    "définition",
    "definition",
    "sens",
    "signification",
    "traduction",
    "bedeutung",
    "übersetzung",
    "ubersetzung",
    "significato",
    "traduzione",
    "tradução",
    "traducao",
    "значение",
    "перевод",
    "معنى",
    "ترجمة",
    "अर्थ",
    "मतलब",
    "অর্থ",
    "معنی",
    "arti",
    "terjemahan",
    "maana",
    "tafsiri",
    "betekenis",
    "betydelse",
    "znaczenie",
    "anlam",
    "nghĩa",
    "σημασία",
    "פירוש",
    "ความหมาย",
  ],
  reading: [
    "reading",
    "pronunciation",
    "kana",
    "furigana",
    "hiragana",
    "pinyin",
    "romaji",
    "romanization",
    "ipa",
    "phonetic",
    "读音",
    "讀音",
    "拼音",
    "注音",
    "発音",
    "読み",
    "よみ",
    "발음",
    "읽기",
    "pronunciación",
    "pronunciacion",
    "prononciation",
    "aussprache",
    "pronuncia",
    "pronúncia",
    "произношение",
    "نطق",
    "उच्चारण",
    "উচ্চারণ",
    "pelafalan",
    "matamshi",
  ],
  ex: [
    "example",
    "examples",
    "sentence",
    "examplesentence",
    "usage",
    "context",
    "例句",
    "例子",
    "例文",
    "用例",
    "예문",
    "예시",
    "ejemplo",
    "oración",
    "oracion",
    "exemple",
    "phrase",
    "beispiel",
    "beispielsatz",
    "satz",
    "esempio",
    "frase",
    "exemplo",
    "пример",
    "предложение",
    "مثال",
    "جملہ",
    "उदाहरण",
    "वाक्य",
    "উদাহরণ",
    "contoh",
    "kalimat",
    "mfano",
    "sentensi",
    "voorbeeld",
    "exempel",
    "przykład",
    "örnek",
    "ví dụ",
    "παράδειγμα",
    "דוגמה",
    "ตัวอย่าง",
  ],
  exTr: [
    "exampletranslation",
    "sentencetranslation",
    "examplemeaning",
    "translationofexample",
    "例句翻译",
    "例句翻譯",
    "例句释义",
    "例句意思",
    "例文訳",
    "例文の訳",
    "예문번역",
    "예문뜻",
    "traduccióndelejemplo",
    "traducciondelejemplo",
    "traductiondelexemple",
    "beispielübersetzung",
    "beispielsatzübersetzung",
    "traduzionedellesempio",
    "traduçãodoexemplo",
    "переводпримера",
    "ترجمةالمثال",
    "उदाहरणकाअर्थ",
    "terjemahancontoh",
    "tafsiriyamfano",
  ],
};

/** A header cell's lookup key: lower case, no spaces, underscores, dashes or dots. */
export const headerKey = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_\-.:'’()]+/g, "");

const ROLE_OF = new Map<string, Role>();
for (const role of ["exTr", "ex", "reading", "back", "term"] as Role[])
  for (const a of HEADER_ALIASES[role]) ROLE_OF.set(headerKey(a), role);

/** List markers stripped from the start of a line: "1. ", "2) ", "- ", "* ", "• ". */
const LIST_MARKER = /^\s*(?:\d{1,6}[.)、．]\s*|[-*•·・]\s+)/;

/**
 * The form a term is compared in, for duplicates and "already have": Unicode
 * NFC, spaces folded, lower case (Unicode-aware, the same in every language).
 */
export const normTerm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

const DELIMS: [Format, string][] = [
  ["tsv", "\t"],
  ["csv", ","],
  ["ssv", ";"],
];

/** Delimiters outside double quotes on one physical line. */
function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/**
 * The delimiter, from the first lines: one that appears on at least 80% of
 * them (rows may leave trailing columns out); on a tie, tab first. A `.tsv`/`.csv` name is only a tie-breaker:
 * a .txt can be a CSV and a .csv a plain list.
 */
export function sniffFormat(text: string, fileName = ""): Format {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim())
    .slice(0, SNIFF_LINES);
  if (!lines.length) return "lines";
  const ext = fileName.toLowerCase().match(/\.(\w+)$/)?.[1];
  const scored: { f: Format; share: number }[] = [];
  for (const [f, d] of DELIMS) {
    const share = lines.filter((l) => countOutsideQuotes(l, d) > 0).length / lines.length;
    if (share >= 0.8) scored.push({ f, share });
  }
  if (!scored.length) return "lines";
  const pref = ext === "tsv" ? "tsv" : ext === "csv" ? "csv" : null;
  scored.sort((a, b) => b.share - a.share || (a.f === pref ? -1 : b.f === pref ? 1 : 0));
  return scored[0].f;
}

/** RFC 4180 rows (quotes may hold delimiters, quotes as "" and line breaks), each with its first line. */
export function splitRows(text: string, delim: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let q = false;
  let line = 1;
  let start = 1;
  let quoted = false;
  const endCell = () => {
    cells.push(quoted ? cell : cell.trim());
    cell = "";
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !cell.trim()) {
      q = true;
      quoted = true;
      cell = "";
    } else if (ch === delim) endCell();
    else if (ch === "\n") {
      endCell();
      out.push({ line: start, cells });
      cells = [];
      line++;
      start = line;
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || cells.length) {
    endCell();
    out.push({ line: start, cells });
  }
  return out;
}

const NO_COLUMNS: Record<Role, number> = { term: -1, back: -1, reading: -1, ex: -1, exTr: -1 };

/** Roles named by a first row, or null when it does not read as a header. */
export function headerColumns(cells: string[]): Record<Role, number> | null {
  const cols = { ...NO_COLUMNS };
  let named = 0;
  cells.forEach((c, i) => {
    const role = ROLE_OF.get(headerKey(c));
    if (role && cols[role] < 0) {
      cols[role] = i;
      named++;
    }
  });
  // A header names at least two columns (the first unnamed one then holds
  // the term, if none is named), or names every cell it has.
  const filled = cells.filter((c) => c.trim()).length;
  if (cols.term < 0 && named >= 2) {
    const used = new Set(Object.values(cols));
    const free = cells.findIndex((_, i) => !used.has(i));
    if (free >= 0) cols.term = free;
  }
  if (cols.term < 0) return null;
  return named >= 2 || named === filled ? cols : null;
}

const clip = (s: string, role: Role) =>
  s.length > MAX_LEN[role] ? s.slice(0, MAX_LEN[role] - 1) + "…" : s;

/** UTF-8 size of a string, without encoding it. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The input as rows of cells, with what the detection makes of it. */
function readTable(input: string, fileName: string) {
  if (utf8Bytes(input) > MAX_BYTES)
    throw new WordListError("too-large", `Over ${MAX_BYTES / 1_000_000} MB`);
  // NUL bytes: a binary file (an .apkg, an image) read as text.
  if (input.includes("\u0000")) throw new WordListError("binary", "Not a text file");
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new WordListError("empty", "No words found");

  const format = sniffFormat(text, fileName);
  const delim = DELIMS.find(([f]) => f === format)?.[1];
  const raw = delim
    ? splitRows(text, delim)
    : text.split("\n").map((l, i) => ({ line: i + 1, cells: [l.replace(LIST_MARKER, "").trim()] }));
  const rowsIn = raw.filter((r) => r.cells.some((c) => c.trim()));
  const head = rowsIn[0] && delim ? headerColumns(rowsIn[0].cells) : null;
  const columns: Record<Role, number> =
    head ?? (delim ? { ...NO_COLUMNS, term: 0, back: 1, ex: 2 } : { ...NO_COLUMNS, term: 0 });
  const width = rowsIn.reduce((w, r) => Math.max(w, r.cells.length), 0);
  return { format, rowsIn, head: !!head, columns, width };
}

/** Rows the mapping step shows on its chips and cards. */
const SHAPE_ROWS = 8;

/**
 * What the mapping step needs (lib/import/column-map.ts): the columns, the
 * header's names, the first rows, and the default mapping (the aliases', or
 * the column order; a registered guesser may improve on it).
 */
export function tableShape(input: string, fileName = "") {
  const { format, rowsIn, head, columns, width } = readTable(input, fileName);
  const first = rowsIn[0]?.cells ?? [];
  const body = (head ? rowsIn.slice(1) : rowsIn).slice(0, SHAPE_ROWS).map((r) => r.cells);
  const fallback = fromColumns(columns, width);
  return {
    format,
    /** A header row was detected (the step lets the user say otherwise). */
    header: head,
    /** The header's cells, when the first row is one. */
    names: head ? first : [],
    /** The first row's cells, header or not. */
    first,
    rows: body,
    width,
    defaults: guessMapping({ header: head ? first : null, rows: body, width }, fallback),
  };
}

export type TableShape = ReturnType<typeof tableShape>;

export type ParseOptions = {
  /** The fields each column fills; without one, the detection decides. */
  mapping?: ColumnMapping;
  /** Whether the first row is a header; without it, the detection decides. */
  header?: boolean;
};

/**
 * Parse a word list. Throws WordListError for input that is not one (too
 * large, empty, binary); everything else becomes rows or counted skips.
 */
export function parseWordList(
  input: string,
  fileName = "",
  opts: ParseOptions = {},
): ParsedWordList {
  const t = readTable(input, fileName);
  const { format, rowsIn } = t;
  const header = opts.header ?? t.head;
  if (header && rowsIn.length) rowsIn.shift();
  const mapping =
    (opts.mapping && cleanMapping(opts.mapping, t.width)) ?? fromColumns(t.columns, t.width);
  const columns = { ...NO_COLUMNS };
  for (const s of SLOTS) columns[s] = mapping[s][0] ?? -1;

  const skippedBy: Record<SkipReason, number> = {
    "no-term": 0,
    "too-long": 0,
    duplicate: 0,
    "over-limit": 0,
  };
  const out: ParsedWordList = {
    format,
    header,
    columns,
    rows: [],
    skipped: [],
    skippedCount: 0,
    skippedBy,
  };
  const skip = (line: number, reason: SkipReason) => {
    out.skippedCount++;
    skippedBy[reason]++;
    if (out.skipped.length < MAX_SKIP_LIST) out.skipped.push({ line, reason });
  };
  const seen = new Set<string>();
  const cell = (cells: string[], role: Role) => slotText(cells, mapping[role]);

  for (const r of rowsIn) {
    const term = cell(r.cells, "term").normalize("NFC");
    if (!term) {
      skip(r.line, "no-term");
      continue;
    }
    if (term.length > MAX_LEN.term) {
      skip(r.line, "too-long");
      continue;
    }
    const key = normTerm(term);
    if (seen.has(key)) {
      skip(r.line, "duplicate");
      continue;
    }
    if (out.rows.length >= MAX_WORDS) {
      skip(r.line, "over-limit");
      continue;
    }
    seen.add(key);
    const row: WordRow = { line: r.line, term, back: clip(cell(r.cells, "back"), "back") };
    for (const role of ["reading", "ex", "exTr"] as const) {
      const v = cell(r.cells, role);
      if (v) row[role] = clip(v, role);
    }
    out.rows.push(row);
  }
  return out;
}

/** FNV-1a over UTF-16 units with a seed: two seeds make a 64-bit key. */
function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A word's stable entry key: the same term (normalized) gets the same key in any import. */
export const termKey = (term: string) => {
  const n = normTerm(term);
  return `w:${fnv(n, 0x811c9dc5)}${fnv(n, 0x01000193)}`;
};

/** A row as a stored entry. */
export function toEntry(r: Omit<WordRow, "line">): ImportEntry {
  const e: ImportEntry = { key: termKey(r.term), term: r.term, back: r.back };
  if (r.reading) e.reading = r.reading;
  if (r.ex) e.ex = r.ex;
  if (r.exTr) e.exTr = r.exTr;
  return e;
}

/** Rows split by whether the user already has the word (`known` holds normTerm forms). */
export function splitKnown<R extends { term: string }>(
  rows: readonly R[],
  known: ReadonlySet<string>,
): { fresh: R[]; have: R[] } {
  const fresh: R[] = [];
  const have: R[] = [];
  for (const r of rows) (known.has(normTerm(r.term)) ? have : fresh).push(r);
  return { fresh, have };
}

/** A list name from a file name: no extension, separators as spaces. */
export function listNameFrom(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]{1,5}$/, "");
  return base.replace(/[_]+/g, " ").trim().slice(0, 120);
}
