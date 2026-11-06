"use client";

// A selected word that is no card of his shows the meaning there already is
// (owner, 2026-11-05 02:11 JST: the card's 查词 — a Wiktionary tab — went): the
// decks and the shared word_gloss rows, or the user's own AI (docs/byok.md).
// Nothing of ours is spent on a preview (owner, 2026-11-06): with no meaning the
// card shows the word in its sentence, and the model runs when the word is
// committed. The fetch is lib/read/select-gloss-fetch.ts. Asked once the selection rests (the combo
// interval), so the levels a quick combo passes through cost nothing; a word
// asked in this tab is never asked again.

import { useEffect, useState } from "react";
import { COMBO_MS } from "@/lib/read/reader-select";
import { fetchGloss, glossKeyOf, glossed, type Gloss } from "@/lib/read/select-gloss-fetch";
import { activeByok } from "@/lib/byok/config";
import type { CardMeaning } from "./reader-select-card";

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
    const timer = setTimeout(ask, glossed.has(glossKeyOf(own, id, w)) ? 0 : COMBO_MS);
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
