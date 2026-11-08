"use client";

// An item's words, for the narrowest review its grade opens (lib/read/
// review-scope.ts: Again → 本段的词): it opens only when the item has a due or
// new word. The set is the swiped item's words (its pieces' sentences,
// paraWords, as the review takes a paragraph's); which of them count comes
// from the server's plan (POST /api/read/[id]/easy-plan, read-only), fetched
// once per item when a slide starts or a grade needs it, and again after his
// cards changed.

import { useCallback, useEffect, useRef } from "react";
import { pieceSentences, type Block, type Fam, type Para } from "@/lib/read/reader-model";
import { paraWords } from "@/lib/read/word-review";
import { rangeWordsOf, type RangeWord } from "./reader-word-review";

type Item = Extract<Block, { kind: "item" }>;

/** What the server can take in one call (lib/read/reader-route.ts rangeWords). */
const MAX_WORDS = 400;

export interface ItemPlan {
  /** The item's words, as the review sends them. */
  words: RangeWord[];
  /** The ones due now or with no card, by the book's word. */
  plan: string[];
}

export function useItemWords(opts: {
  id: string;
  /** Off: the device's own reader (no server cards): nothing follows a grade. */
  on: boolean;
  para: (line: number) => Para;
  fam: Map<string, Fam> | null;
  normLang: string;
}) {
  const { id, on, para, fam, normLang } = opts;
  const cache = useRef(new Map<string, Promise<ItemPlan | null>>());
  const known = useRef(new Map<string, ItemPlan>());
  // His cards changed (the word map came again): every plan is asked again.
  useEffect(() => {
    cache.current.clear();
    known.current.clear();
  }, [fam]);
  const wordsOf = useCallback(
    (b: Item) => {
      const ss = b.pieces.flatMap((pc) => pieceSentences(para(pc.line), pc));
      return rangeWordsOf(paraWords(ss, fam), ss, normLang).then((w) => w.slice(0, MAX_WORDS));
    },
    [para, fam, normLang],
  );

  const planOf = useCallback(
    (b: Item): Promise<ItemPlan | null> => {
      if (!on) return Promise.resolve(null);
      const had = cache.current.get(b.id);
      if (had) return had;
      const p = wordsOf(b)
        .then(async (words) => {
          if (!words.length) return { words, plan: [] };
          const r = await fetch(`/api/read/${id}/easy-plan`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ words }),
          });
          if (!r.ok) throw new Error(`easy-plan: HTTP ${r.status}`);
          const { words: plan } = (await r.json()) as { words: string[] };
          return { words, plan };
        })
        .then((x) => {
          known.current.set(b.id, x);
          return x;
        })
        .catch(() => {
          // Asked again next time.
          cache.current.delete(b.id);
          return null;
        });
      cache.current.set(b.id, p);
      return p;
    },
    [on, id, wordsOf],
  );

  return { planOf };
}
