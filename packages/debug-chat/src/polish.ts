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
 * - **Added words** (nothing replaced) never: that is inventing.
 *
 * No word lists, no language branches (docs/design-principles.md): the rules
 * are the same for every script; segmentation is the platform's own.
 */

/** The context a polish may draw on. */
export type PolishContext = string[];

export type PolishVerdict = { ok: true } | { ok: false; reason: string };

/** How far a replacement may differ in length from what it replaces (see above). */
const SAME_AUDIO = 2;

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

/** Is a polished text of a voice line one the context supports? */
export function polishCheck(raw: string, polished: string, context: PolishContext): PolishVerdict {
  const rawSpans = spans(raw);
  const a = rawSpans.map((x) => x.w);
  // Word i is written up against word i + 1, nothing between (no space, no mark).
  const joined = rawSpans.map((x, i) => rawSpans[i + 1]?.start === x.end);
  const b = polishWords(polished);
  // Spaceless, so a run matches however a script spaces (or segments) it.
  const known = context.map(polishWords);
  for (const h of diff(a, b)) {
    const said = h.del.join(" ");
    const put = h.ins.join(" ");
    if (!h.ins.length) {
      if (isRepeat(a, h, joined)) continue;
      return { ok: false, reason: `drops "${said}", which is not a repeat: it may be meaning` };
    }
    if (!h.del.length) return { ok: false, reason: `adds "${put}", which was not said` };
    // A replacement that only drops or adds characters (不要 → 要) is a removal
    // or an addition in disguise: held to those rules.
    const rest = trimShared(h.del.join(""), h.ins.join(""));
    // The same characters, only segmented differently: not a change.
    if (!rest.ins && !rest.del) continue;
    if (!rest.ins)
      return { ok: false, reason: `"${said}" → "${put}" drops "${rest.del}": it may be meaning` };
    if (!rest.del) return { ok: false, reason: `"${said}" → "${put}" adds "${rest.ins}", which was not said` };
    if (!inContext(h.ins.join(""), known))
      return { ok: false, reason: `"${said}" → "${put}": "${put}" is not in the context` };
    const g = graphemes(h.del.join(""));
    const p = graphemes(h.ins.join(""));
    if (p > g * SAME_AUDIO || g > p * SAME_AUDIO)
      return { ok: false, reason: `"${said}" → "${put}": a rewrite, not a misheard word` };
  }
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
