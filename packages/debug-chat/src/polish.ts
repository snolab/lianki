/**
 * The polish of a voice line, held to what the context supports
 * (docs/dev-debug-widget.md, "Agent edits of voice messages").
 *
 * STT has no context, so it mishears (流式 → 流失, sync → sink). The chat lane
 * has the context and may correct the owner's latest voice line — but a
 * polish that drifts is worse than the raw line. So the hub checks every edit
 * here, against the raw STT text and the line's context (the thread's recent
 * lines, the page's path and title, the words on screen, the attached
 * selection), and refuses anything else:
 *
 * - **Punctuation, spacing, case and width** may change freely: they are not
 *   words (`Intl.Segmenter`'s `isWordLike` decides, for every script alike).
 * - **A replaced run of words** is allowed only when what replaces it is in
 *   the context as whole words (never part of one), and it does not merely
 *   drop or add characters (不要 → 要 is a removal): a homophone the context disambiguates. Its length stays
 *   within a factor of two of the run it replaces, in graphemes — a
 *   mishearing covers the same stretch of audio, so it cannot double or halve
 *   what was said; anything past that is a rewrite, not a correction.
 * - **Removed words** only when they repeat what is right next to them (a
 *   stutter: 我我我想 → 我想, the the → the). Anything else removed may be
 *   meaning (不).
 * - **Added words** (nothing replaced) never: that is inventing — but for
 *   function words, below.
 * - **A truncated word completed** (fl → flag, pinner → spinner): a word that
 *   lost letters at its start or end, in a script that spaces its words, may
 *   take them back when the whole word is in the context and the fragment
 *   itself is not (so a word he may really have said is never rewritten).
 *   The length bound above holds.
 * - **Function words** (`FUNCTION_WORDS`: particles, measure words,
 *   articles, prepositions — 的, 了, 在, 里, the, of…) may be added, or swapped
 *   for one another, without the context: at most `MAX_FUNCTION_FIXES` per
 *   line. Never a negation or a question word (不, 没, 吗, not): those are
 *   meaning, and are not in the lists.
 * - **An unclear word** may be written as a bracket of candidates,
 *   "（没听清，票？，条？）" (`polishCheck` below), instead of a guess.
 *
 * No language branches (docs/design-principles.md): the rules are the same for
 * every script; segmentation is the platform's own. The one list is data per
 * script class (`FUNCTION_WORDS`), never per language.
 *
 * A **summary** (`summaryCheck`) is another kind of edit with its own rule:
 * the chat lane may collapse a run of his voice lines that were not addressed
 * to it (room talk, someone else talking) into one short line saying what was
 * said. The word rules above do not apply to it.
 */

/** The context a polish may draw on. */
export type PolishContext = string[];

export type PolishVerdict = { ok: true } | { ok: false; reason: string };

/** How far a replacement may differ in length from what it replaces (see above). */
const SAME_AUDIO = 2;

type ScriptClass = "Han" | "Kana" | "Hangul" | "Latin" | "Cyrillic";

/**
 * Function words a polish may add or swap without the context, per script
 * class (the script of the word's letters, never a language): grammar glue
 * that STT drops or mishears and that carries no content of its own. In a
 * script that does not space its words each entry is one character, and a
 * run of them counts one per character. Negations and question particles are
 * deliberately absent.
 */
export const FUNCTION_WORDS: Readonly<Record<ScriptClass, readonly string[]>> = {
  Han: ["的", "地", "得", "了", "着", "过", "在", "里", "上", "中", "个", "吧", "呢", "啊", "呀", "嘛"],
  Kana: ["は", "が", "を", "に", "で", "へ", "と", "の"],
  Hangul: ["은", "는", "이", "가", "을", "를", "에", "의"],
  Latin: ["a", "an", "the", "of", "to", "in", "on", "at", "for", "with", "by", "from", "into"],
  Cyrillic: ["в", "на", "с", "к", "по", "о", "у"],
};
/** At most this many function words added or swapped in one line. */
export const MAX_FUNCTION_FIXES = 2;

const SCRIPTS: [ScriptClass, RegExp][] = [
  ["Han", /^\p{Script=Han}+$/u],
  ["Kana", /^[\p{Script=Hiragana}\p{Script=Katakana}]+$/u],
  ["Hangul", /^\p{Script=Hangul}+$/u],
  ["Latin", /^\p{Script=Latin}+$/u],
  ["Cyrillic", /^\p{Script=Cyrillic}+$/u],
];
/** Scripts that space their words, where a word can lose letters at an edge. */
const SPACED: ReadonlySet<ScriptClass> = new Set(["Latin", "Cyrillic"]);
/** Scripts written without spaces: a function word there is one character. */
const SPACELESS: ReadonlySet<ScriptClass> = new Set(["Han", "Kana"]);

const scriptOf = (w: string): ScriptClass | null =>
  SCRIPTS.find(([, re]) => re.test(w))?.[0] ?? null;

/**
 * How many function words these words are, or null when any is not one. A
 * word of a spaceless script counts if every character is a function word
 * (the segmenter may join 里 to the word before it).
 */
export function functionWords(words: readonly string[]): number | null {
  let n = 0;
  for (const w of words) {
    const sc = scriptOf(w);
    if (!sc) return null;
    const list = FUNCTION_WORDS[sc];
    if (list.includes(w)) n++;
    else if (SPACELESS.has(sc) && [...w].every((ch) => list.includes(ch))) n += [...w].length;
    else return null;
  }
  return n;
}

const segmenter = () => new Intl.Segmenter(undefined, { granularity: "word" });

/** NFKC, lower case: what makes two words the same word. */
const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** The words of a text, normalised; punctuation and spaces are not words. */
export function polishWords(text: string): string[] {
  return spans(text).map((x) => x.w);
}

/** The words, and where each sits in the normalised text. */
function spans(text: string): { w: string; start: number; end: number }[] {
  const out: { w: string; start: number; end: number }[] = [];
  for (const s of segmenter().segment(norm(text))) {
    // Marks inside a word (can't, let's, e-mail) are punctuation too.
    const w = s.isWordLike ? s.segment.replace(/[^\p{L}\p{N}\p{M}]/gu, "") : "";
    if (w) out.push({ w, start: s.index, end: s.index + s.segment.length });
  }
  return out;
}

/**
 * Is `run` (spaceless) in the context as whole words: some run of a context
 * line's consecutive words, joined? Never part of a word ("now" is not in
 * "snow"); a script segmented differently still matches at its boundaries.
 */
function inContext(run: string, context: string[][]): boolean {
  for (const words of context) {
    const joined = words.join("");
    const starts = new Set<number>();
    const ends = new Set<number>();
    let at = 0;
    for (const w of words) {
      starts.add(at);
      ends.add((at += w.length));
    }
    for (let i = joined.indexOf(run); i >= 0; i = joined.indexOf(run, i + 1))
      if (starts.has(i) && ends.has(i + run.length)) return true;
  }
  return false;
}

/** `ins` with what it shares with `del` at either end taken off, and `del`'s rest. */
function trimShared(del: string, ins: string): { del: string; ins: string } {
  const a = [...del];
  const b = [...ins];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { del: a.slice(p, a.length - q).join(""), ins: b.slice(p, b.length - q).join("") };
}

const graphemes = (s: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

/** One difference between the raw words and the polished ones. */
type Hunk = { at: number; del: string[]; ins: string[] };

/** The word-level diff (LCS), as hunks of removed and added words. */
function diff(a: string[], b: string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      cur = null;
      i++;
      j++;
      continue;
    }
    if (!cur) hunks.push((cur = { at: i, del: [], ins: [] }));
    if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) cur.ins.push(b[j++]!);
    else cur.del.push(a[i++]!);
  }
  return hunks;
}

/**
 * The removed run repeats what is right next to it (a stutter): it is copies
 * of one unit, said again right before or after it, as whole words — or, a
 * single character written up against it with no space, which is how a
 * script that does not space its words stutters (我我我想 → 我想: its
 * segmenter may join the last 我 to 想). Never part of a longer word: "not" is not repeated by "notify".
 */
function isRepeat(raw: string[], h: Hunk, joined: boolean[]): boolean {
  const run = h.del.join("");
  const before = raw.slice(0, h.at);
  const after = raw.slice(h.at + h.del.length);
  /** The words' joined text starts (or ends) with `unit`, at a word boundary unless it is one grapheme. */
  const next = (words: string[], unit: string, fromEnd: boolean) => {
    const text = words.join("");
    if (!(fromEnd ? text.endsWith(unit) : text.startsWith(unit))) return false;
    // One character counts only where the text itself does not space it off
    // (我我我想, not "I insist"): its writing, not a language, decides.
    if (graphemes(unit) === 1) return fromEnd ? !!joined[h.at - 1] : !!joined[h.at + h.del.length - 1];
    let at = 0;
    for (const w of fromEnd ? [...words].reverse() : words) {
      at += w.length;
      if (at === unit.length) return true;
      if (at > unit.length) return false;
    }
    return false;
  };
  for (let n = 1; n <= run.length; n++) {
    const unit = run.slice(0, n);
    if (run.length % n || unit.repeat(run.length / n) !== run) continue;
    return next(before, unit, true) || next(after, unit, false);
  }
  return false;
}

/**
 * The word rules (above) on one reading of the polish. `alike`: candidates of
 * an unclear-word bracket, which may replace a run as its sound-alike.
 */
function wordCheck(
  raw: string,
  polished: string,
  context: PolishContext,
  alike: ReadonlySet<string> = new Set(),
): PolishVerdict {
  const rawSpans = spans(raw);
  const a = rawSpans.map((x) => x.w);
  // Word i is written up against word i + 1, nothing between (no space, no mark).
  const joined = rawSpans.map((x, i) => rawSpans[i + 1]?.start === x.end);
  const b = polishWords(polished);
  // Spaceless, so a run matches however a script spaces (or segments) it.
  const known = context.map(polishWords);
  let fixes = 0;
  /** Count n function-word fixes; false when they are none, or not function words. */
  const fix = (n: number | null) => n !== null && n > 0 && ((fixes += n), true);
  for (const h of diff(a, b)) {
    const said = h.del.join(" ");
    const put = h.ins.join(" ");
    if (!h.ins.length) {
      if (isRepeat(a, h, joined)) continue;
      return { ok: false, reason: `drops "${said}", which is not a repeat: it may be meaning` };
    }
    if (!h.del.length) {
      if (fix(functionWords(h.ins))) continue;
      return { ok: false, reason: `adds "${put}", which was not said` };
    }
    // A replacement that only drops or adds characters (不要 → 要) is a removal
    // or an addition in disguise: held to those rules.
    const rest = trimShared(h.del.join(""), h.ins.join(""));
    // The same characters, only segmented differently: not a change.
    if (!rest.ins && !rest.del) continue;
    if (!rest.ins)
      return { ok: false, reason: `"${said}" → "${put}" drops "${rest.del}": it may be meaning` };
    const g = graphemes(h.del.join(""));
    const p = graphemes(h.ins.join(""));
    const sameAudio = p <= g * SAME_AUDIO && g <= p * SAME_AUDIO;
    if (!rest.del) {
      if (sameAudio && isCompletion(h, known)) continue;
      if (alike.has(h.ins.join("")) && soundAlike(h.del.join(""), h.ins.join(""))) continue;
      // 房间 → 房间里: a function word written up against a word.
      if (fix(functionWords([rest.ins]))) continue;
      return {
        ok: false,
        reason: `"${said}" → "${put}" adds "${rest.ins}", which was not said`,
      };
    }
    // One function word for another (the → a, 在 → 里).
    const fd = functionWords(h.del);
    const fi = functionWords(h.ins);
    if (fd !== null && fi !== null && fix(Math.max(fd, fi))) continue;
    // A bracket's candidate standing for what he said, as its sound-alike.
    if (alike.has(h.ins.join("")) && soundAlike(h.del.join(""), h.ins.join(""))) continue;
    if (!inContext(h.ins.join(""), known))
      return { ok: false, reason: `"${said}" → "${put}": "${put}" is not in the context` };
    if (!sameAudio)
      return { ok: false, reason: `"${said}" → "${put}": a rewrite, not a misheard word` };
  }
  if (fixes > MAX_FUNCTION_FIXES)
    return {
      ok: false,
      reason: `${fixes} function words added or changed: at most ${MAX_FUNCTION_FIXES} a line`,
    };
  return { ok: true };
}

/**
 * The "didn't catch it" phrase that opens an unclear-word bracket, per line
 * language, as data: the chat lane writes the one for the line's language.
 * The hub takes any of them (it never guesses a language).
 */
export const UNCLEAR_PHRASES: Readonly<Record<string, string>> = {
  zh: "没听清",
  en: "unclear",
  ja: "聞き取れず",
  ko: "잘 안 들림",
  fr: "pas compris",
  de: "unklar",
  es: "no se entendió",
};
/** At most this many candidates in one bracket. */
export const MAX_UNCLEAR_CANDIDATES = 3;
/** At most this many unclear-word brackets in one line. */
export const MAX_UNCLEAR_BRACKETS = 2;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * "（没听清，票？，条？）", "(unclear, ticket?, strip?)": an opening bracket,
 * the phrase, then each candidate followed by "?", comma-separated, and a
 * closing bracket; full-width or ASCII punctuation alike.
 */
const UNCLEAR = new RegExp(
  `[（(]\\s*(?:${Object.values(UNCLEAR_PHRASES).map(esc).join("|")})\\s*[，,、]\\s*` +
    `((?:[^，,、？?（）()]+[？?]\\s*[，,、]?\\s*)+)[）)]`,
  "giu",
);

/** The candidates of a bracket's inside: "票？，条？" → ["票", "条"]. */
const candidatesOf = (inner: string) =>
  inner
    .split(/[？?]/u)
    .map((x) => x.replace(/^[\s，,、]+|[\s，,、]+$/gu, ""))
    .filter(Boolean);

/** Edit distance (graphemes), for a candidate spelled like the word it stands for. */
function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[y.length]!;
}

/**
 * A candidate shaped like a sound-alike of the raw run it stands for: the same
 * stretch of audio, and spelled within half its letters of it (pinner /
 * spinner), or, in a script that does not space its words, as many characters
 * (票 / 条: a homophone has the raw word's syllables, one character each).
 */
function soundAlike(said: string, cand: string): boolean {
  const g = graphemes(said);
  const p = graphemes(cand);
  if (!g || !p || p > g * SAME_AUDIO || g > p * SAME_AUDIO) return false;
  const sc = scriptOf(said);
  if (sc && SPACELESS.has(sc)) return scriptOf(cand) === sc && p === g;
  return distance(said, cand) <= Math.ceil(Math.max(g, p) / 2);
}

/**
 * Is a polished text of a voice line one the context supports? The word rules
 * above, and **unclear words**: where he cannot be sure what was said, the
 * polish may replace one raw run with a bracket of candidates,
 * "（没听清，票？，条？）" or "(unclear, ticket?, strip?)", instead of guessing
 * (at most MAX_UNCLEAR_CANDIDATES a bracket, MAX_UNCLEAR_BRACKETS a line).
 * Each candidate, put alone in the bracket's place, must pass the word rules,
 * where a candidate may also stand for the run it replaces as a sound-alike
 * (`soundAlike`) without being in the context. The raw text stays as `raw`.
 */
export function polishCheck(raw: string, polished: string, context: PolishContext): PolishVerdict {
  // If the polish contains an inferred guess bracket, e.g. "（随口说说？）" or "(just saying?)",
  // which does not start with an unclear phrase, treat it as a tentative trailing thought
  // and check the text with the guess bracket stripped.
  const hasUnclearPrefix = /[（(]\s*(?:没听清|unclear|no se entendió)\s*[，,、]/iu;
  const strippedOfGuesses = polished.replace(/[（(][^）)]*[？?][）)]/gu, (m) =>
    hasUnclearPrefix.test(m) ? m : "",
  );
  const textToCheck = strippedOfGuesses.trim() ? strippedOfGuesses : polished;

  const brackets = [...textToCheck.matchAll(UNCLEAR)];
  if (!brackets.length) return wordCheck(raw, textToCheck, context);
  if (brackets.length > MAX_UNCLEAR_BRACKETS)
    return {
      ok: false,
      reason: `${brackets.length} unclear-word brackets: at most ${MAX_UNCLEAR_BRACKETS} a line`,
    };
  const cands = brackets.map((b) => candidatesOf(b[1]!));
  for (const [i, c] of cands.entries()) {
    if (!c.length) return { ok: false, reason: `"${brackets[i]![0]}" names no candidate` };
    if (c.length > MAX_UNCLEAR_CANDIDATES)
      return {
        ok: false,
        reason: `"${brackets[i]![0]}": at most ${MAX_UNCLEAR_CANDIDATES} candidates a word`,
      };
    if (c.some((x) => polishWords(x).length === 0))
      return { ok: false, reason: `"${brackets[i]![0]}": a candidate with no word` };
  }
  /** The polish with bracket i read as `pick[i]`. */
  const reading = (pick: string[]) => {
    let out = "";
    let at = 0;
    brackets.forEach((b, i) => {
      out += textToCheck.slice(at, b.index) + pick[i];
      at = b.index! + b[0].length;
    });
    return out + textToCheck.slice(at);
  };
  const alike = new Set(cands.flat().map((x) => polishWords(x).join("")));
  const first = cands.map((c) => c[0]!);
  for (const [i, c] of cands.entries())
    for (const cand of c) {
      const pick = [...first];
      pick[i] = cand;
      const v = wordCheck(raw, reading(pick), context, alike);
      if (!v.ok) return { ok: false, reason: `"${brackets[i]![0]}": ${v.reason}` };
    }
  return { ok: true };
}

/**
 * One word that lost letters at its start or end (fl → flag, pinner →
 * spinner), in a script that spaces its words: the whole word is in the
 * context and the fragment is not (he may really have said a word that is).
 * Two graphemes at least: one letter is no evidence of which word it was.
 */
function isCompletion(h: Hunk, known: string[][]): boolean {
  if (h.del.length !== 1 || h.ins.length !== 1) return false;
  const frag = h.del[0]!;
  const word = h.ins[0]!;
  const sc = scriptOf(frag);
  if (!sc || !SPACED.has(sc) || scriptOf(word) !== sc || graphemes(frag) < 2) return false;
  if (!word.startsWith(frag) && !word.endsWith(frag)) return false;
  return inContext(word, known) && !inContext(frag, known);
}

/** How long a summary may be, as a share of the raw lines it stands for (graphemes). */
export const SUMMARY_SHARE = 0.4;

/**
 * Is `summary` a fair shape for a summary of a run of his voice lines that
 * were not addressed to the lane (room talk, someone else speaking)? One
 * sentence, at most SUMMARY_SHARE of the raw text, and more than one word: it
 * says what was said, never a bare "noise" marker, because he may have said
 * something that matters and wants to be heard. Keeping the meaning is the
 * lane's duty (docs/dev-debug-widget.md, "Summaries"); the raw lines are kept
 * whatever this says.
 */
export function summaryCheck(raws: readonly string[], summary: string): PolishVerdict {
  const text = summary.trim();
  if (!raws.length) return { ok: false, reason: "a summary needs the lines it stands for" };
  if (!text) return { ok: false, reason: "a summary needs text" };
  const total = raws.reduce((n, r) => n + graphemes(r.trim()), 0);
  const len = graphemes(text);
  if (len > total * SUMMARY_SHARE)
    return {
      ok: false,
      reason: `a summary of ${len} characters is over ${Math.round(SUMMARY_SHARE * 100)}% of the ${total} it stands for`,
    };
  const sentences = [
    ...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text),
  ].filter((x) => x.segment.trim());
  if (sentences.length > 1) return { ok: false, reason: "a summary is one sentence" };
  if (polishWords(text).length < 2)
    return { ok: false, reason: "a summary says what was said, not only that something was" };
  return { ok: true };
}

/**
 * How long a merged passage may be, as a multiple of the lines it stands for
 * (graphemes), plus MERGE_SLACK for the connectives a short run needs. A
 * conservative default (docs/dev-debug-widget.md, "Merged passages"): a
 * passage joins and smooths his words, it does not add to them.
 */
export const MERGE_RATIO = 1.3;
/** Graphemes a passage may add beyond MERGE_RATIO: a few connectives and marks. */
export const MERGE_SLACK = 8;

/**
 * Is `passage` a fair shape for ONE fluent passage made of a run of his
 * consecutive voice lines? The per-line word rules (`polishCheck`) do not
 * apply: connectives and fragment fixes are allowed, and keeping the meaning
 * is the lane's duty. Held here: at least two lines, a text, and no longer
 * than MERGE_RATIO times the lines plus MERGE_SLACK. The raw lines are kept
 * whatever this says, and the merge can be undone.
 */
export function mergeCheck(
  raws: readonly string[],
  passage: string,
  limits: { ratio?: number; slack?: number } = {},
): PolishVerdict {
  const ratio = limits.ratio ?? MERGE_RATIO;
  const slack = limits.slack ?? MERGE_SLACK;
  const text = passage.trim();
  if (raws.length < 2) return { ok: false, reason: "a merge joins two or more lines" };
  if (!text) return { ok: false, reason: "a merged passage needs text" };
  const total = raws.reduce((n, r) => n + graphemes(r.trim()), 0);
  const len = graphemes(text);
  const cap = Math.ceil(total * ratio) + slack;
  if (len > cap)
    return {
      ok: false,
      reason: `a passage of ${len} characters is longer than the ${total} it joins allow (${ratio}x + ${slack} = ${cap})`,
    };
  return { ok: true };
}

/**
 * What a voice line's polish may draw on: the line's own scene (the page and
 * its screen), its attached selection, and the thread's other lines.
 */
export function polishContext(
  line: { scene?: { path?: string; title?: string; screen?: string }; context?: { selection: string } },
  recent: string[],
): PolishContext {
  const s = line.scene;
  return [
    ...(s?.path ? [s.path.replace(/[/_-]+/g, " ").trim()] : []),
    ...(s?.title ? [s.title] : []),
    ...(s?.screen ? [s.screen] : []),
    ...(line.context ? [line.context.selection] : []),
    ...recent,
  ];
}
