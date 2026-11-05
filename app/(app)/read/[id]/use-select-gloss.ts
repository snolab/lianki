"use client";

// A selected word that is no card of his gets its meaning by itself (owner,
// 2026-11-05 02:11 JST: the card's 查词 — a Wiktionary tab — went; a tap
// already shows a card's meaning, so a word with no card shows its gloss the
// same way). POST /api/read/[id]/gloss: the decks over the book's lemmas,
// the shared word_gloss rows, else the model (charged through chargeAi).
// Asked once the selection rests (the combo interval), so the levels a quick
// combo passes through cost nothing; a word asked in this tab is never asked
// again.
//
// With the user's own AI on (docs/byok.md), the route is asked with
// `own: true`: decks and word_gloss only, no model, no charge. What they lack
// is asked of the user's provider from this browser, and the answer stays in
// this tab — never written to the shared word_gloss rows.

import { useEffect, useState } from "react";
import { COMBO_MS } from "@/lib/read/reader-select";
import { glossMessages, parseGlosses } from "@/lib/read/gloss";
import { activeByok, type ByokActive } from "@/lib/byok/config";
import { byokComplete, type ByokDeps } from "@/lib/byok/call";
import type { CardMeaning } from "./reader-select-card";

type Gloss = { term: string; back: string | null; own?: boolean };
/** What the route answers; `ask` (with `own`) is the headword the decks lack. */
type Answer = Gloss & { ask?: { lang: string; term: string } | null };

/** Glosses of this tab by book and word (`own:` first for the user's own AI); null when there is none. */
const done = new Map<string, Gloss | null>();
const inflight = new Map<string, Promise<Gloss | null>>();

const keyOf = (own: ByokActive | null, id: string, w: string) =>
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
  const k = keyOf(own, id, w);
  if (done.has(k)) return Promise.resolve(done.get(k) ?? null);
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
        done.set(k, out);
        return out;
      })
      .catch(() => null)
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

/**
 * The gloss of `word` (the book's normalised word; null: nothing to ask),
 * as a card meaning; `text` is the word as the book writes it.
 */
export function useSelectGloss(
  id: string,
  word: { w: string; text: string; ex: string | null } | null,
): CardMeaning | null {
  const [got, setGot] = useState<{ w: string; g: Gloss } | null>(null);
  const w = word?.w ?? null;
  const ex = word?.ex ?? null;
  useEffect(() => {
    if (!w) return;
    let live = true;
    const own = activeByok();
    const ask = () =>
      void fetchGloss(id, w, ex, own).then((g) => {
        if (live && g) setGot({ w, g });
      });
    const timer = setTimeout(ask, done.has(keyOf(own, id, w)) ? 0 : COMBO_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, w, ex]);
  if (!word || got?.w !== word.w || !got.g.back) return null;
  const term = got.g.term;
  return {
    term,
    back: got.g.back,
    other: term !== word.w && term !== word.text.trim(),
    own: got.g.own === true,
  };
}
