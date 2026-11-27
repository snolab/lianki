/**
 * Does a roadmap wish name an exam deck of the word-list catalogue
 * (public/words/index.json, the entries with an `exam`)? One generic rule
 * over the catalogue's own data, no per-language or per-exam code: a deck's
 * names are its `level` ("N1", "HSK 7–9"), its exam plus level ("JLPT N1"),
 * its `exam` + `level` and its id without the language prefix ("jlpt-n1").
 * Names and wish are compared case-insensitively with spaces and punctuation
 * removed ("jlpt n1" = "JLPT-N1" = "jlptn1"), as whole runs of the wish's
 * words, so "n1" in "python1" is no match.
 */

export type ExamDeckMeta = {
  id: string;
  name: string;
  lang: string;
  exam?: string;
  level?: string;
};

/** Lower case, width-folded, letters and digits only. */
export const squash = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** The wish's words: runs of ASCII letters/digits, or of any other letters. */
function words(s: string): string[] {
  return (
    s
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9]+|[^\sa-z0-9\p{P}\p{S}]+/gu) ?? []
  );
}

/** The names a deck answers to, squashed. Shorter than 2 characters or digits only: none. */
export function deckNames(d: ExamDeckMeta): string[] {
  const names = new Set<string>();
  const add = (s: string | undefined) => {
    const q = s ? squash(s) : "";
    if (q.length >= 2 && !/^\d+$/.test(q)) names.add(q);
  };
  add(d.level);
  if (d.exam && d.level) add(`${d.exam} ${d.level}`);
  add(d.id.startsWith(`${d.lang}-`) ? d.id.slice(d.lang.length + 1) : d.id);
  add(d.id);
  return [...names];
}

/** At most this many consecutive words make one name ("hsk 7 9" is three). */
const MAX_RUN = 4;

/**
 * The exam decks the wish names, most specific first: the decks whose
 * longest matched name is longest. A name shared by several decks (one
 * level name in two exams) gives all of them. None: [].
 */
export function matchExamDecks<D extends ExamDeckMeta>(wish: string, catalogue: D[]): D[] {
  const w = words(wish);
  const runs = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    let run = "";
    for (let j = i; j < Math.min(w.length, i + MAX_RUN); j++) {
      run += w[j];
      runs.add(run);
    }
  }
  let best = 0;
  let found: D[] = [];
  for (const d of catalogue) {
    if (!d.exam) continue;
    const len = Math.max(
      0,
      ...deckNames(d)
        .filter((n) => runs.has(n))
        .map((n) => n.length),
    );
    if (!len) continue;
    if (len > best) {
      best = len;
      found = [d];
    } else if (len === best) found.push(d);
  }
  return found;
}

/** The /words address that offers a catalogue deck: opens it when added, else ticks it to add. */
export const deckHref = (id: string) => `/words?deck=${encodeURIComponent(id)}`;
