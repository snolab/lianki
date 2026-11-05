// The reader v2's model of a book (docs/books-plan.md, "Owner decisions
// 19:40": the book as it is, swiped item by item). Pure and isomorphic, so it
// is unit-tested without a browser (unit/read-reader-model.test.ts).
//
// - **Blocks.** What the virtualised list renders, in reading order: a
//   heading, or an *item* — a run of whole sentences, the unit he grades with
//   a swipe. Short paragraphs merge into one item; a long one is split at
//   sentence ends, and its pieces still read as one paragraph.
// - **Pieces.** An item's parts, one per paragraph it touches: the
//   paragraph's line and the range of its sentences.
// - **Units.** Every paragraph is cut once, when it is first shown, into
//   sentences and word tokens (Intl.Segmenter in the book's language; no
//   per-language code). Their indexes are the stable addresses the deep links
//   use (`#s=<line>.<sentence>`, `#w=<line>.<token>`, docs/books-plan.md):
//   a token's index counts the paragraph's word-like segments from 0.
//
// Until the backend's items (lib/read/reader-api.ts, feat/reader-data) are
// here, `localItems` derives them on the device from the book's lines.

import { normWord } from "./words";
import { wordSegments } from "./word-segments";

export interface Piece {
  line: number;
  /** First sentence of the line in this piece. */
  s0: number;
  /** One past the last sentence; -1: to the end of the paragraph. */
  s1: number;
}

export type Block =
  | { kind: "heading"; line: number }
  | {
      kind: "item";
      /** Stable: "<line>.<sentence>" of its first sentence (local), or the server's item key. */
      id: string;
      pieces: Piece[];
      /** The server's familiarity of the item, 0..1 (words and his grades); absent: from the words. */
      fam?: number;
    };

/** A word's familiarity, as its mark shows it. */
export type Fam = "k" | "l1" | "l2" | "l3" | "n" | "u";

export interface Seg {
  text: string;
  /** Word-like: its token index in the paragraph; otherwise -1. */
  t: number;
  /** Its normalised form (lib/read/words.ts normWord), when it is a counted word. */
  w: string | null;
  /** Inline emphasis over it, outermost first. */
  k?: InlineKind[];
  /** A word whose emphasis changes inside it: its parts, each with its own. */
  parts?: { text: string; k?: InlineKind[] }[];
}

export interface Sentence {
  segs: Seg[];
  text: string;
}

export interface Para {
  sentences: Sentence[];
}

// ── Sizing ──────────────────────────────────────────────────────────────

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORDS = /[\p{L}\p{N}]+/gu;

/** A quick word count for sizing items (a CJK character counts half a word). */
export function roughWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, " ").match(WORDS)?.length ?? 0;
  return rest + cjk / 2;
}

/**
 * Words in one item. No fixed number for everyone (design-principles.md):
 * the time a person takes to read a short passage — the lower end of the
 * 1–3 minute rule — at their own speed. Until their speed is measured, the
 * caller passes a starting speed.
 */
export function itemWords(wordsPerMinute: number, minutes = 1): number {
  return Math.max(1, Math.round(wordsPerMinute * minutes));
}

// ── Sentences and tokens ────────────────────────────────────────────────

const segCache = new Map<string, { word: Intl.Segmenter; sentence: Intl.Segmenter }>();
function segmenters(lang: string) {
  let s = segCache.get(lang);
  if (!s) {
    const tag = lang && lang !== "und" ? lang : undefined;
    let word: Intl.Segmenter;
    let sentence: Intl.Segmenter;
    try {
      word = new Intl.Segmenter(tag, { granularity: "word" });
      sentence = new Intl.Segmenter(tag, { granularity: "sentence" });
    } catch {
      word = new Intl.Segmenter(undefined, { granularity: "word" });
      sentence = new Intl.Segmenter(undefined, { granularity: "sentence" });
    }
    s = { word, sentence };
    segCache.set(lang, s);
  }
  return s;
}

/** A paragraph's sentences, as text (whitespace kept with the sentence before it). */
export function sentencesOf(text: string, lang: string): string[] {
  const out: string[] = [];
  for (const s of segmenters(lang).sentence.segment(text)) {
    if (!s.segment.trim() && out.length) out[out.length - 1] += s.segment;
    else out.push(s.segment);
  }
  return out.length ? out : [text];
}

/**
 * Sentences from explicit [start, end) cuts (the backend's sentence refs,
 * lib/read/reader-api.ts SentenceRef): text between and after the cuts goes
 * with the sentence before it, text before the first with the first, so the
 * paragraph renders back exactly.
 */
export function sentencesFromCuts(text: string, cuts: readonly [number, number][]): string[] {
  if (!cuts.length) return [text];
  const out: string[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = i === 0 ? 0 : cuts[i][0];
    const end = i + 1 < cuts.length ? cuts[i + 1][0] : text.length;
    out.push(text.slice(start, end));
  }
  return out;
}

/** Inline emphasis on a paragraph: [start, end, kind], UTF-16 offsets (the EPUB's own). */
export type LineMark = [start: number, end: number, kind: InlineKind];
export type InlineKind = "em" | "strong" | "sup" | "sub";

/**
 * A paragraph cut into sentences and tokens. `normLang` is the language the
 * book's words were counted in (lib/read/words.ts), so a token's `w` matches
 * the word map's keys. `cuts`: the sentences as the backend cut them (else
 * Intl.Segmenter's). `marks`: the paragraph's inline emphasis.
 */
export function cutPara(
  text: string,
  lang: string,
  normLang = lang,
  cuts?: readonly [number, number][] | null,
  marks?: readonly LineMark[] | null,
): Para {
  const { word } = segmenters(lang);
  let t = 0;
  let base = 0;
  const kindsAt = (o: number): InlineKind[] | undefined => {
    if (!marks?.length) return undefined;
    const k = marks.filter((m) => m[0] <= o && o < m[1]).map((m) => m[2]);
    return k.length ? k : undefined;
  };
  /** A word whose emphasis changes inside it (H<sub>2</sub>O): its parts, else null. */
  const partsOf = (seg: string, o: number): { text: string; k?: InlineKind[] }[] | null => {
    if (!marks?.length) return null;
    if (
      !marks.some((m) => (m[0] > o && m[0] < o + seg.length) || (m[1] > o && m[1] < o + seg.length))
    )
      return null;
    const parts: { text: string; k?: InlineKind[] }[] = [];
    for (let i = 0; i < seg.length; i++) {
      const k = kindsAt(o + i);
      const last = parts[parts.length - 1];
      if (last && String(last.k) === String(k)) last.text += seg[i];
      else parts.push({ text: seg[i], ...(k ? { k } : {}) });
    }
    return parts;
  };
  const texts = cuts ? sentencesFromCuts(text, cuts) : sentencesOf(text, lang);
  const sentences = texts.map((st) => {
    const segs: Seg[] = [];
    for (const s of wordSegments(word, st)) {
      const o = base + s.index;
      const k = kindsAt(o);
      const last = segs[segs.length - 1];
      if (s.isWordLike) {
        const parts = partsOf(s.segment, o);
        segs.push({
          text: s.segment,
          t: t++,
          w: normWord(s.segment, normLang),
          ...(parts ? { parts } : k ? { k } : {}),
        });
      }
      // Runs of non-words merge (fewer nodes), when they carry the same emphasis.
      else if (last && last.t < 0 && String(last.k) === String(k)) last.text += s.segment;
      else segs.push({ text: s.segment, t: -1, w: null, ...(k ? { k } : {}) });
    }
    base += st.length;
    return { segs, text: st };
  });
  return { sentences };
}

/** Per-line extras from the backend: sentence cuts and inline marks. */
export interface LineExtras {
  cuts?(line: number): readonly [number, number][] | null;
  marks?(line: number): readonly LineMark[] | null;
  /** A line's own language (a book that mixes them), else the book's. */
  lang?(line: number): string;
}

/** Paragraphs already cut, per book: a paragraph is cut once, when first shown. */
export class ParaCache {
  private map = new Map<number, Para>();
  constructor(
    private lines: readonly string[],
    private lang: string,
    private normLang = lang,
    private max = 400,
    private extras: LineExtras = {},
  ) {}
  get(line: number): Para {
    let p = this.map.get(line);
    if (p) {
      // Most recent last: the oldest goes first when the cache is full.
      this.map.delete(line);
      this.map.set(line, p);
      return p;
    }
    p = cutPara(
      this.lines[line] ?? "",
      this.extras.lang?.(line) ?? this.lang,
      this.normLang,
      this.extras.cuts?.(line),
      this.extras.marks?.(line),
    );
    this.map.set(line, p);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as number);
    return p;
  }
}

/** Inline marks of a book (BookMeta.marks: [line, start, end, kind]) by line. */
export function marksByLine(
  marks: readonly (readonly [number, number, number, string])[] | undefined,
): Map<number, LineMark[]> {
  const m = new Map<number, LineMark[]>();
  const kinds = new Set(["em", "strong", "sup", "sub"]);
  for (const [line, a, z, k] of marks ?? []) {
    if (!kinds.has(k)) continue;
    const list = m.get(line) ?? [];
    list.push([a, z, k as InlineKind]);
    m.set(line, list);
  }
  return m;
}

// ── Items (the local adapter) ───────────────────────────────────────────

export interface LocalItemsInput {
  lines: readonly string[];
  headings: ReadonlySet<number>;
  /** Chapter starts: an item never runs across one. */
  chapterStarts: ReadonlySet<number>;
  lang: string;
  /** A line's own language (a book that mixes them): an item never holds two. */
  langOf?: (line: number) => string;
  /** Words an item holds (itemWords). */
  target: number;
}

/**
 * Blocks from the book's lines: headings on their own; paragraphs merged
 * into items while they fit the target; a paragraph past 1.5× the target cut
 * at sentence ends into pieces of about the target. Never across a heading
 * or a chapter start.
 */
export function localItems(o: LocalItemsInput): Block[] {
  const out: Block[] = [];
  let cur: Piece[] = [];
  let curWords = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({ kind: "item", id: `${cur[0].line}.${cur[0].s0}`, pieces: cur });
    cur = [];
    curWords = 0;
  };
  const langOf = o.langOf ?? (() => o.lang);
  for (let line = 0; line < o.lines.length; line++) {
    const text = o.lines[line] ?? "";
    if (!text.trim()) continue;
    if (o.headings.has(line) || o.chapterStarts.has(line)) flush();
    if (cur.length && langOf(cur[cur.length - 1].line) !== langOf(line)) flush();
    if (o.headings.has(line)) {
      out.push({ kind: "heading", line });
      continue;
    }
    const w = roughWords(text);
    if (w > o.target * 1.5) {
      flush();
      const sents = sentencesOf(text, langOf(line));
      let s0 = 0;
      let acc = 0;
      for (let s = 0; s < sents.length; s++) {
        const sw = roughWords(sents[s]);
        if (acc > 0 && acc + sw > o.target) {
          cur = [{ line, s0, s1: s }];
          flush();
          s0 = s;
          acc = 0;
        }
        acc += sw;
      }
      cur = [{ line, s0, s1: -1 }];
      curWords = acc;
      if (curWords >= o.target) flush();
      continue;
    }
    if (curWords > 0 && curWords + w > o.target) flush();
    cur.push({ line, s0: 0, s1: -1 });
    curWords += w;
  }
  flush();
  return out;
}

/** The block index holding `line` (the first, for a split paragraph). */
export function blockOfLine(blocks: readonly Block[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let ans = 0;
  const first = (b: Block) => (b.kind === "heading" ? b.line : b.pieces[0].line);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (first(blocks[mid]) <= line) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // A split paragraph's first piece is the one that starts at sentence 0.
  while (ans > 0 && first(blocks[ans - 1]) === line) ans--;
  return ans;
}

/** The block a position points at: its line and the first sentence of its piece. */
export function blockOfAnchor(blocks: readonly Block[], line: number, s = 0): number {
  let i = blockOfLine(blocks, line);
  // Later pieces of the same split paragraph follow its first block.
  while (
    s > 0 &&
    i + 1 < blocks.length &&
    blocks[i + 1].kind === "item" &&
    (blocks[i + 1] as Extract<Block, { kind: "item" }>).pieces[0].line === line &&
    (blocks[i + 1] as Extract<Block, { kind: "item" }>).pieces[0].s0 <= s
  )
    i++;
  return i;
}

/** The first line a block shows. */
export const blockLine = (b: Block) => (b.kind === "heading" ? b.line : b.pieces[0].line);

/** A piece's sentences out of its paragraph. */
export function pieceSentences(p: Para, piece: Piece): Sentence[] {
  return p.sentences.slice(piece.s0, piece.s1 < 0 ? undefined : piece.s1);
}

/** What read-aloud says for a block: one entry per sentence, in order, with its address. */
export function blockSpeech(
  b: Block,
  para: (line: number) => Para,
  lineText: (line: number) => string,
): { text: string; line: number; s: number }[] {
  if (b.kind === "heading") return [{ text: lineText(b.line), line: b.line, s: 0 }];
  const out: { text: string; line: number; s: number }[] = [];
  for (const pc of b.pieces) {
    const ss = pieceSentences(para(pc.line), pc);
    ss.forEach((st, i) => {
      if (st.text.trim()) out.push({ text: st.text.trim(), line: pc.line, s: pc.s0 + i });
    });
  }
  return out;
}

// ── Familiarity ─────────────────────────────────────────────────────────

/**
 * /api/read/[id]/words rows: [word, count, score 0..1 (-1: no card),
 * mastered, in own deck, name, in the dictionary, headwords].
 */
export type WordRow = [string, number, number, 0 | 1, 0 | 1, 0 | 1, (0 | 1)?, string[]?];

/** A learning word's band, by its card's score: l1 weakest. Thirds of the deck's own 0..1 scale. */
export function learningBand(score: number): "l1" | "l2" | "l3" {
  return score < 1 / 3 ? "l1" : score < 2 / 3 ? "l2" : "l3";
}

/**
 * The word map: each distinct word's familiarity. `inLists` says whether a
 * word without a card is in one of our lists (the catalog cache), as the scan
 * summary decides it (BookWords.tsx).
 */
export function famMap(
  rows: readonly WordRow[],
  inLists: (w: string) => boolean,
): Map<string, Fam> {
  const m = new Map<string, Fam>();
  for (const [w, , score, mastered, own, name, dict, heads] of rows) {
    let f: Fam;
    if (score >= 0) f = mastered ? "k" : learningBand(score);
    else if (name) f = "k";
    else if (own || dict || inLists(w) || heads?.some(inLists)) f = "n";
    else f = "u";
    m.set(w, f);
  }
  return m;
}

/** Coverage of an item's running words (known ÷ counted), 0..1; null when it has none. */
export function itemCoverage(sentences: readonly Sentence[], fam: Map<string, Fam>): number | null {
  let n = 0;
  let known = 0;
  for (const s of sentences)
    for (const g of s.segs) {
      if (!g.w) continue;
      const f = fam.get(g.w);
      if (!f) continue;
      n++;
      if (f === "k") known++;
    }
  return n ? known / n : null;
}

/** The rail's strength for a coverage: 0 (unknown) … 4 (all known); a share, not a count. */
export const railLevel = (c: number | null) => (c === null ? -1 : Math.min(4, Math.floor(c * 5)));
