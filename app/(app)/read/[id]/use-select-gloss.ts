"use client";

// A selected word that is no card of his gets its meaning by itself (owner,
// 2026-11-05 02:11 JST: the card's 查词 — a Wiktionary tab — went; a tap
// already shows a card's meaning, so a word with no card shows its gloss the
// same way). POST /api/read/[id]/gloss: the decks over the book's lemmas,
// the shared word_gloss rows, else the model (charged through chargeAi).
// Asked once the selection rests (the combo interval), so the levels a quick
// combo passes through cost nothing; a word asked in this tab is never asked
// again.

import { useEffect, useState } from "react";
import { COMBO_MS } from "@/lib/read/reader-select";
import type { CardMeaning } from "./reader-select-card";

type Gloss = { term: string; back: string | null };

/** Glosses of this tab by book and word; null when there is none. */
const done = new Map<string, Gloss | null>();
const inflight = new Map<string, Promise<Gloss | null>>();

function fetchGloss(id: string, w: string, ex: string | null) {
  const k = `${id}\u0000${w}`;
  if (done.has(k)) return Promise.resolve(done.get(k) ?? null);
  let p = inflight.get(k);
  if (!p) {
    p = fetch(`/api/read/${id}/gloss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ w, ex }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<Gloss>) : null))
      .then((g) => {
        const out = g?.back ? g : null;
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
    const ask = () =>
      void fetchGloss(id, w, ex).then((g) => {
        if (live && g) setGot({ w, g });
      });
    const timer = setTimeout(ask, done.has(`${id}\u0000${w}`) ? 0 : COMBO_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, w, ex]);
  if (!word || got?.w !== word.w || !got.g.back) return null;
  const term = got.g.term;
  return { term, back: got.g.back, other: term !== word.w && term !== word.text.trim() };
}
