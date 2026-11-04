"use client";

// An item's words, for what follows its grade (owner, 2026-11-05 02:31 /
// 02:32 JST; lib/read/word-review.ts afterGrade): Easy also grades its due
// and new words Easy, any other grade opens its word review when it has
// such a word. The set is the swiped item's words (its pieces' sentences,
// paraWords, as the review takes a paragraph's); which of them count comes
// from the server's plan (POST /api/read/[id]/easy-plan, read-only), fetched
// once per item when a slide starts or a grade needs it, and again after his
// cards changed.

import { useCallback, useEffect, useRef } from "react";
import { pieceSentences, type Block, type Fam, type Para } from "@/lib/read/reader-model";
import { paraWords, planLeft } from "@/lib/read/word-review";
import { rangeWordsOf, type RangeWord } from "./reader-word-review";

type Item = Extract<Block, { kind: "item" }>;

/** What the server can take in one call (lib/read/reader-route.ts rangeWords). */
const MAX_WORDS = 400;

export interface ItemPlan {
  /** The item's words, as the review and the Easy batch send them. */
  words: RangeWord[];
  /** The ones an Easy grade would grade now (due, or no card), by the book's word. */
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
  /** Words in Easy grades still waiting to be sent, by grade (an undo takes them back). */
  const waiting = useRef(new Map<string, string[]>());

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

  const waitingSet = () => new Set([...waiting.current.values()].flat());
  /** The plan's words not already in an Easy grade waiting to be sent. */
  const left = useCallback((p: ItemPlan) => planLeft(p.plan, waitingSet()), []);
  /** The count known now for the hint, or null (still being asked). */
  const countNow = useCallback(
    (b: Item) => {
      const p = known.current.get(b.id);
      return p ? left(p).length : null;
    },
    [left],
  );

  return {
    planOf,
    countNow,
    left,
    /** An Easy grade's words wait in the hold: other items' counts leave them out. */
    hold: useCallback((key: string, words: string[]) => waiting.current.set(key, words), []),
    release: useCallback((key: string) => waiting.current.delete(key), []),
    /** The review's words: the item's, without those an Easy grade waiting will grade. */
    reviewWords: useCallback((p: ItemPlan) => {
      const w = waitingSet();
      return p.words.filter((x) => !w.has(x.w));
    }, []),
  };
}
