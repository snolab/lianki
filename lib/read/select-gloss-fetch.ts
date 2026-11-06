// A selected word's meaning, fetched once per tab (the hook:
// app/(app)/read/[id]/use-select-gloss.ts). POST /api/read/[id]/gloss: the
// decks over the book's lemmas, the shared word_gloss rows, else the model
// (charged through chargeAi). A tap asks for it (owner's card, 2026-11-06 18:18
// JST: 点开就查释义); the slider's commit then reuses it (`withTabGloss`).
//
// With the user's own AI on (docs/byok.md), the route is asked with
// `own: true`: decks and word_gloss only, no model, no charge. What they lack
// is asked of the user's provider from this browser, and the answer stays in
// this tab until he commits the word — never written to the shared word_gloss rows.
//
// `fetchCachedGloss` is the private speech of a /vibe doc (docs/vibe.md): decks
// and word_gloss only (`cached: true`), neither our model nor his provider, for
// as long as the word is not committed.

import { glossMessages, parseGlosses } from "./gloss";
import { activeByok, type ByokActive } from "@/lib/byok/config";
import { byokComplete, type ByokDeps } from "@/lib/byok/call";

export type Gloss = { term: string; back: string | null; own?: boolean };
/** What the route answers; `ask` (with `own`) is the headword the decks lack. */
type Answer = Gloss & { ask?: { lang: string; term: string } | null };

/** Glosses of this tab by book and word (`own:` first for the user's own AI); null when there is none. */
export const glossed = new Map<string, Gloss | null>();
const inflight = new Map<string, Promise<Gloss | null>>();

export const glossKeyOf = (own: ByokActive | null, id: string, w: string) =>
  `${own ? "own:" : ""}${id}\u0000${w}`;
/** Apart from the others: "nothing cached" is no answer to a tap that may ask the model. */
export const cachedKeyOf = (id: string, w: string) => `cached:${id}\u0000${w}`;

/** The headword's gloss by the user's own AI, from this browser. */
export async function glossOwn(
  own: ByokActive,
  ask: { lang: string; term: string },
  ex: string | null,
  deps?: ByokDeps,
): Promise<string | null> {
  const r = await byokComplete(
    own,
    glossMessages(ask.lang, [{ term: ask.term, ex }]),
    { maxTokens: 400, temperature: 0.2 },
    deps,
  );
  return r.ok ? (parseGlosses(r.text, [ask.term]).get(ask.term) ?? null) : null;
}

type Post = (body: unknown) => Promise<Response>;

function ask(
  k: string,
  post: Post,
  body: unknown,
  own: ByokActive | null,
  ex: string | null,
  deps?: ByokDeps,
): Promise<Gloss | null> {
  if (glossed.has(k)) return Promise.resolve(glossed.get(k) ?? null);
  let p = inflight.get(k);
  if (!p) {
    p = post(body)
      // Refused or failed (a word not in the book yet, the network): no answer, asked again next time.
      .then((r) => (r.ok ? (r.json() as Promise<Answer>) : Promise.reject(new Error("gloss"))))
      .then(async (g): Promise<Gloss | null> => {
        if (own && !g.back && g.ask) {
          const back = await glossOwn(own, g.ask, ex, deps);
          return back ? { term: g.ask.term, back, own: true } : null;
        }
        return g.back ? { term: g.term, back: g.back } : null;
      })
      .then((out) => {
        glossed.set(k, out);
        return out;
      })
      .catch(() => null)
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

const routePost =
  (id: string, deps?: ByokDeps): Post =>
  (body) =>
    (deps?.fetch ?? fetch)(`/api/read/${id}/gloss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

/**
 * A tapped word's meaning, at most one ask per tab. `deps.post`: another way to
 * the same route (the live doc saves first when the word is not in the book yet).
 */
export function fetchGloss(
  id: string,
  w: string,
  ex: string | null,
  own: ByokActive | null = activeByok(),
  deps?: ByokDeps & { post?: Post },
) {
  return ask(
    glossKeyOf(own, id, w),
    deps?.post ?? routePost(id, deps),
    // Only the word and its sentence: the user's key and backend never come here.
    own ? { w, ex, own: true } : { w, ex },
    own,
    ex,
    deps,
  );
}

/** What meaning there already is, asking no model of anyone. */
export function fetchCachedGloss(id: string, w: string, ex: string | null, deps?: ByokDeps) {
  return ask(cachedKeyOf(id, w), routePost(id, deps), { w, ex, cached: true }, null, ex, deps);
}

type WordOf = { w: string; term?: string | null; back?: string | null };

/** The tap's gloss still on its way for these words: settled before a commit is sent. */
export const glossSettled = (id: string, words: WordOf[], own: ByokActive | null) =>
  Promise.all(words.map((x) => inflight.get(glossKeyOf(own, id, x.w))));

/**
 * A commit's words with the meaning the tap found, so it asks for nothing again
 * (and a user's own AI's answer is what goes on his card, without our model).
 */
export const withTabGloss = <T extends WordOf>(
  id: string,
  words: T[],
  own: ByokActive | null,
): T[] =>
  words.map((x) => {
    const g = x.back ? null : glossed.get(glossKeyOf(own, id, x.w));
    return g?.back ? { ...x, term: x.term ?? g.term, back: g.back } : x;
  });
