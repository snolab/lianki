"use client";

// A selected word that is no card of his gets its meaning by itself (owner,
// 2026-11-05 02:11 JST: the card's 查词 — a Wiktionary tab — went; owner's card,
// 2026-11-06 18:18 JST: 点开就查释义，要花积分): the decks, the shared word_gloss
// rows, else the model through chargeAi, or the user's own AI (docs/byok.md). It
// stores no card: the slider does. The fetch is lib/read/select-gloss-fetch.ts.
// Asked once the selection rests (the combo interval), so the levels a quick
// combo passes through cost nothing; a word asked in this tab is never asked again.

import { useEffect, useState } from "react";
import { COMBO_MS } from "@/lib/read/reader-select";
import {
  cachedKeyOf,
  fetchCachedGloss,
  fetchGloss,
  glossKeyOf,
  glossed,
  type Gloss,
} from "@/lib/read/select-gloss-fetch";
import { activeByok } from "@/lib/byok/config";
import type { CardMeaning } from "./reader-select-card";

/**
 * The gloss of `word` (the book's normalised word; null: nothing to ask),
 * as a card meaning; `text` is the word as the book writes it. `cachedOnly`: a
 * /vibe doc's private speech, no model before a swipe (docs/vibe.md).
 */
export function useSelectGloss(
  id: string,
  word: { w: string; text: string; ex: string | null } | null,
  cachedOnly = false,
): CardMeaning | null {
  const [got, setGot] = useState<{ w: string; g: Gloss } | null>(null);
  const w = word?.w ?? null;
  const ex = word?.ex ?? null;
  useEffect(() => {
    if (!w) return;
    let live = true;
    const own = cachedOnly ? null : activeByok();
    const ask = () =>
      void (cachedOnly ? fetchCachedGloss(id, w, ex) : fetchGloss(id, w, ex, own)).then((g) => {
        if (live && g) setGot({ w, g });
      });
    const key = cachedOnly ? cachedKeyOf(id, w) : glossKeyOf(own, id, w);
    const timer = setTimeout(ask, glossed.has(key) ? 0 : COMBO_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, w, ex, cachedOnly]);
  if (!word || got?.w !== word.w || !got.g.back) return null;
  const term = got.g.term;
  return {
    term,
    back: got.g.back,
    other: term !== word.w && term !== word.text.trim(),
    own: got.g.own === true,
  };
}
