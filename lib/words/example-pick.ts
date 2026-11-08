/**
 * One example sentence per showing (owner, 2026-11-03 20:01 JST:
 * "如果有多个例句可用，每次可以随机显示其中的一个").
 *
 * A word-list entry may carry alternatives besides its `ex` (`exs`, any
 * deck, any language). Each time the card enters a study queue one is picked
 * at random, never the one shown last time when there are two or more, and
 * frozen into the queued item: re-renders and scrolling never change it, and
 * read-aloud (sayParts) reads the one shown. With a single example nothing
 * changes. The last shown per card is remembered on this device only.
 *
 * Today every bundled deck stores one example (scripts/words/examples.ts
 * picks the best of the Wiktionary usage examples and Tatoeba sentences it
 * finds); emitting `exs` there is what turns this on for a deck.
 */
export type Example = {
  ex: string;
  exTr?: string;
  /** This example sung in a YouTube song (lib/yt-songs/card-clip.ts): it goes where its sentence goes. */
  clip?: string;
};

/** The examples an entry offers: its `ex` first, then its alternatives; empty ones and repeats left out. */
export function examplesOf(e: {
  ex?: string;
  exTr?: string;
  clip?: string;
  exs?: Example[];
}): Example[] {
  const out: Example[] = [];
  const add = (x: Example | undefined) => {
    if (x?.ex?.trim() && !out.some((o) => o.ex === x.ex)) out.push(x);
  };
  if (e.ex)
    add({ ex: e.ex, ...(e.exTr ? { exTr: e.exTr } : {}), ...(e.clip ? { clip: e.clip } : {}) });
  for (const x of e.exs ?? []) add(x);
  return out;
}

/** One at random, not `last` when there is another to show. */
export function pickExample(
  examples: Example[],
  last: string | undefined,
  rand: () => number = Math.random,
): Example | undefined {
  if (examples.length <= 1) return examples[0];
  const pool = examples.filter((x) => x.ex !== last);
  const from = pool.length ? pool : examples;
  return from[Math.min(from.length - 1, Math.floor(rand() * from.length))];
}

const LAST_KEY = "lk:words-last-example";
const LAST_CAP = 500;

/** Per device: the example last shown for each card (`key`: list and term). */
export function lastExample(key: string): string | undefined {
  try {
    const m = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>;
    return m[key];
  } catch {
    return undefined;
  }
}

export function rememberExample(key: string, ex: string): void {
  try {
    const m = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, string>;
    delete m[key];
    m[key] = ex;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - LAST_CAP))) delete m[k];
    localStorage.setItem(LAST_KEY, JSON.stringify(m));
  } catch {
    // Storage blocked: the pick is still random, only repeats are not avoided.
  }
}

/** The entry with one of its examples chosen for this showing (unchanged with fewer than two). */
export function withPickedExample<
  T extends { ex?: string; exTr?: string; clip?: string; exs?: Example[] },
>(e: T, key: string, rand: () => number = Math.random): T {
  const all = examplesOf(e);
  if (all.length < 2) return e;
  const x = pickExample(all, lastExample(key), rand)!;
  rememberExample(key, x.ex);
  const { exTr: _drop, clip: _clip, ...rest } = e;
  return {
    ...rest,
    ex: x.ex,
    ...(x.exTr ? { exTr: x.exTr } : {}),
    ...(x.clip ? { clip: x.clip } : {}),
  } as T;
}
