/**
 * Senses of a dictionary entry, joined into a list's `back` (build-word-lists.ts,
 * patch-hsk-backs.ts). Pure: unit/words-senses.test.ts.
 */

/** Join senses with "; " keeping the result ≤ max chars (always ≥ 1 sense). */
export function joinSenses(senses: string[], max = 80, maxSenses = 3): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let s of senses) {
    s = s
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.;:,]+$/, "");
    if (!s || seen.has(s.toLowerCase())) continue;
    if (!out.length && s.length > max) s = truncate(s, max);
    const next = [...out, s].join("; ");
    if (next.length > max) {
      if (out.length) break;
    }
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= maxSenses) break;
  }
  return out.join("; ");
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // prefer cutting at a clause boundary, then a word boundary
  const cut = s.slice(0, max - 1);
  const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "));
  if (clause > max * 0.5) return cut.slice(0, clause);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;(]+$/, "") + "…";
}

// ---------------------------------------------------------------- CC-CEDICT forms (HSK)

/** A form of an HSK word as complete-hsk-vocabulary gives it: its reading and CC-CEDICT senses. */
export type CedictForm = { t?: string; i?: { y?: string }; m?: string[] };

/** Senses that are only a note about the word, not a meaning. */
export const isNoiseSense = (m: string) =>
  /^(surname |abbr\. |variant of |old variant of |used in |see [^ ]|\(old\) variant|erhua variant|Japanese variant|\(Tw\))/i.test(
    m,
  );

/**
 * A sense limited to a register or period ("(classical) to say", "(archaic)
 * …", "(literary) …"): a meaning, but not the one a learner meets first.
 */
export const isMarkedSense = (m: string) =>
  /^\((classical|archaic|literary|old|dialect|obsolete|historical)\b[^)]*\)/i.test(m.trim());

const sensesOf = (f: CedictForm) =>
  (f.m ?? [])
    .filter((m) => !isNoiseSense(m))
    .flatMap((m) => m.split(/;\s*/))
    .filter((s) => s.trim());

/**
 * The reading and senses of a word with several CC-CEDICT forms. The form
 * kept is a common-noun reading (yǐ, not Yǐ "Israel") with the most plain
 * senses — a sense marked classical or archaic counts for less, so 云 is
 * "cloud" (from 雲) before "(classical) to say" (from 云). The other forms
 * with the same reading, spelled as the word itself or as the kept form,
 * add their senses after it: every sense of the word is on the card, the
 * plain ones first.
 */
export function hskSenses(
  forms: readonly CedictForm[],
  term: string,
): { reading: string; senses: string[] } {
  const reading = (f: CedictForm) => String(f.i?.y ?? "");
  // Counted per CC-CEDICT gloss, as the lists were first built (a gloss may hold "a; b").
  const score = (f: CedictForm) => {
    const s = (f.m ?? []).filter((m) => !isNoiseSense(m));
    // A form with only classical/archaic glosses loses a tie (云 "(classical) to say" vs 雲 "cloud").
    const onlyMarked = s.length > 0 && s.every(isMarkedSense);
    return (/^\p{Lu}/u.test(reading(f)) ? 0 : 1000) + s.length - (onlyMarked ? 0.5 : 0);
  };
  const ranked = forms
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
  const best = ranked[0];
  if (!best) return { reading: "", senses: [] };
  const y = reading(best);
  // Only spellings of this very word: a form whose traditional spelling is
  // another character (帆 from 颿 "to gallop") is a different word.
  const same = ranked.filter(
    (f) => f === best || (reading(f) === y && (f.t === term || f.t === best.t)),
  );
  const all = same.flatMap(sensesOf);
  const senses = all.length ? all : (best.m ?? []).flatMap((m) => m.split(/;\s*/));
  // Plain senses first, the marked ones after (a stable partition).
  return {
    reading: y,
    senses: [...senses.filter((s) => !isMarkedSense(s)), ...senses.filter(isMarkedSense)],
  };
}
