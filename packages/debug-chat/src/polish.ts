/**
 * Agent edits of the owner's chat lines (docs/dev-debug-widget.md, "Agent
 * edits of voice messages").
 *
 * **Polish is unrestricted (owner, 2026-11-14):** "改字是允许的，我们现在把所有
 * 的润色相关的限制给删掉，不要有任何限制。先给最大的自由度，等我真的觉得润色错了
 * 的时候再考虑对应措施。" A polish may substitute, add, drop, reorder or rewrite
 * words, on any of his lines. The old word rules (deletion-only, context-backed
 * homophones, function-word budget, unclear-word brackets) are gone; what stays
 * is not a rule on the words: the raw text is kept for undo, and the line is
 * marked polished. Who may edit at all is the hub's auth (a live owner grant).
 *
 * A **summary** (`summaryCheck`) is another kind of edit with its own shape:
 * the chat lane may collapse a run of his voice lines that were not addressed
 * to it (room talk, someone else talking) into one short line saying what was
 * said.
 */

export type PolishVerdict = { ok: true } | { ok: false; reason: string };

const segmenter = () => new Intl.Segmenter(undefined, { granularity: "word" });

/** NFKC, lower case: what makes two words the same word. */
const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** The words of a text, normalised; punctuation and spaces are not words. */
export function polishWords(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter().segment(norm(text))) {
    // Marks inside a word (can't, let's, e-mail) are punctuation too.
    const w = s.isWordLike ? s.segment.replace(/[^\p{L}\p{N}\p{M}]/gu, "") : "";
    if (w) out.push(w);
  }
  return out;
}


const graphemes = (s: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

/**
 * Is `polished` an acceptable polish of `raw`? Any non-empty text is: polish
 * is unrestricted (owner, 2026-11-14; see above). The raw text is kept beside
 * it, so the polish can always be undone.
 */
export function polishCheck(_raw: string, polished: string): PolishVerdict {
  return polished.trim() ? { ok: true } : { ok: false, reason: "a polish needs text" };
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
 * Is `passage` a fair shape for ONE passage made of a run of his consecutive
 * voice lines? Two lines at least, and a text. No length cap and no word
 * rules: a merge is a polish, and polish is unrestricted (owner, 2026-11-14).
 * The raw lines are kept, and the merge can be undone.
 */
export function mergeCheck(raws: readonly string[], passage: string): PolishVerdict {
  if (raws.length < 2) return { ok: false, reason: "a merge joins two or more lines" };
  if (!passage.trim()) return { ok: false, reason: "a merged passage needs text" };
  return { ok: true };
}
