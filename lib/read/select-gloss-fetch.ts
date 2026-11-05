// A selected word's meaning, fetched once per tab (the hook:
// app/(app)/read/[id]/use-select-gloss.ts). POST /api/read/[id]/gloss: the
// decks over the book's lemmas, the shared word_gloss rows, else the model
// (charged through chargeAi).
//
// With the user's own AI on (docs/byok.md), the route is asked with
// `own: true`: decks and word_gloss only, no model, no charge. What they lack
// is asked of the user's provider from this browser, and the answer stays in
// this tab — never written to the shared word_gloss rows.

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

export function fetchGloss(
  id: string,
  w: string,
  ex: string | null,
  own: ByokActive | null = activeByok(),
  deps?: ByokDeps,
) {
  const k = glossKeyOf(own, id, w);
  if (glossed.has(k)) return Promise.resolve(glossed.get(k) ?? null);
  let p = inflight.get(k);
  if (!p) {
    p = (deps?.fetch ?? fetch)(`/api/read/${id}/gloss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Only the word and its sentence: the user's key and backend never come here.
      body: JSON.stringify(own ? { w, ex, own: true } : { w, ex }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<Answer>) : null))
      .then(async (g): Promise<Gloss | null> => {
        if (own && g && !g.back && g.ask) {
          const back = await glossOwn(own, g.ask, ex, deps);
          return back ? { term: g.ask.term, back, own: true } : null;
        }
        return g?.back ? { term: g.term, back: g.back } : null;
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
