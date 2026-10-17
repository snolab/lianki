/**
 * Adds one post to the serialized lib/blog.corpus.json, reproducing
 * scripts/gen-blog-corpus.ts byte-for-byte.
 *
 * The translate route commits a new translation through the GitHub API, where
 * there is no checkout to run gen-blog-corpus in. It still has to update the
 * corpus in the same commit — unit/blog-corpus.test.ts fails on any drift, and
 * the Worker only ever sees the bundled corpus. Matching the generator's exact
 * output (not just its content) keeps the next local commit from reshuffling
 * the whole file.
 */

/** buildCorpus walks locales sorted, then *filenames* sorted — `x.lock.md` before `x.md`. */
function compareCorpusKeys(a: string, b: string): number {
  const cut = (k: string) => {
    const i = k.indexOf("/");
    return [k.slice(0, i), `${k.slice(i + 1)}.md`] as const;
  };
  const [la, fa] = cut(a);
  const [lb, fb] = cut(b);
  if (la !== lb) return la < lb ? -1 : 1;
  if (fa !== fb) return fa < fb ? -1 : 1;
  return 0;
}

export function insertIntoCorpus(json: string, key: string, content: string): string {
  const corpus = JSON.parse(json) as Record<string, string>;
  corpus[key] = content;
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(corpus).sort(compareCorpusKeys)) sorted[k] = corpus[k]!;
  return JSON.stringify(sorted, null, 2) + "\n";
}
