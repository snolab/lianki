"use client";

// The language a unit of the book is read aloud in, and which language's
// entry a selected word means (lib/read/sense-pick.ts has the rules).
//
// - Each line's language is the book's stored runs (BookMeta.langs), else
//   detected here from the lines themselves (lib/read/lang-detect.ts): a
//   book imported before the runs existed still reads its English lines in
//   English and its Japanese lines in Japanese. Only the voice and the
//   lookup use it; the cutting of sentences stays the server's.
// - A word's language is its line's, refined by its own script among the
//   book's languages (langIn: Han in a Japanese line is Japanese).
// - The entries looked up: the word's own language's list catalogue (loaded
//   when first needed), then the book's deck (his cards and lists in the
//   book's word language), as before.

import { useCallback, useEffect, useMemo, useState } from "react";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { catalogWords } from "@/lib/read/dict";
import { detectLangs, langAt, langIn } from "@/lib/read/lang-detect";
import {
  matchMeaning,
  meaningIndex,
  type MeaningHit,
  type MeaningIndex,
  type ParaTokens,
} from "@/lib/read/select-meaning";
import {
  checkPicks,
  pickFor,
  PICKS_KEY,
  senseView,
  voiceLangOf,
  withPick,
  type SenseEntry,
  type SensePicks,
  type SenseView,
} from "@/lib/read/sense-pick";

/** Lines past this are not scanned on the device (the book's own language reads them). */
const DETECT_MAX_LINES = 20_000;

const base = (l: string) => l.toLowerCase().split(/[-_]/)[0];

function loadPicks(): SensePicks {
  try {
    return checkPicks(JSON.parse(localStorage.getItem(PICKS_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

/** A selection's tokens in one paragraph. */
export interface SenseSpan {
  toks: ParaTokens;
  t0: number;
  t1: number;
  /** The selected text, as the book has it. */
  text: string;
  /** Its sentence (the pick's context). */
  sentence: string;
  line: number;
}

export interface WordSense {
  view: SenseView;
  /** The hit of the entry shown (its span may be a phrase around the selection). */
  hit: MeaningHit;
}

export function useWordSense(o: {
  lines: readonly string[];
  runs: readonly (readonly [number, string])[] | undefined;
  /** The book's language (BCP 47, its region kept for the voice). */
  lang: string;
  /** The language of the book's deck (meanIdx). */
  normLang: string;
  meanIdx: readonly MeaningIndex[];
}) {
  const { lines, runs, lang, normLang, meanIdx } = o;
  const detected = useMemo(() => {
    if (runs?.length || !lines.length || lines.length > DETECT_MAX_LINES) return null;
    return detectLangs(lines);
  }, [lines, runs]);
  /** A line's language, for its voice: the book's own tag when it is the book's language. */
  const sayLang = useCallback(
    (line: number) => {
      const l = runs?.length ? langAt(runs, line, lang) : (detected?.[line] ?? lang);
      return base(l) === base(lang) ? lang : l;
    },
    [runs, detected, lang],
  );
  const bookLangs = useMemo(() => {
    const ls = runs?.length ? runs.map((r) => r[1]) : (detected ?? []);
    return [...new Set([base(lang), ...ls.map(base)])];
  }, [runs, detected, lang]);
  /** A word's (or phrase's) own language, from its line and its script. */
  const wordLangAt = useCallback(
    (line: number, text: string) => langIn(text, bookLangs, base(sayLang(line))),
    [bookLangs, sayLang],
  );

  // His picks (lib/read/sense-pick.ts), kept in step with the account's copy.
  const [picks, setPicks] = useState<SensePicks>({});
  useEffect(() => {
    setPicks(loadPicks());
    const on = () => setPicks(loadPicks());
    window.addEventListener(PREF_APPLIED_EVENT, on);
    return () => window.removeEventListener(PREF_APPLIED_EVENT, on);
  }, []);
  const pick = useCallback((surface: string, sentence: string, choice: string) => {
    setPicks((p) => {
      const next = withPick(p, surface, sentence, choice);
      try {
        localStorage.setItem(PICKS_KEY, JSON.stringify(next));
        notePrefWrite(); // docs/prefs-sync.md
      } catch {}
      return next;
    });
  }, []);
  /** The language `text` is read aloud in: his pick's, else its own. */
  const voiceLang = useCallback(
    (line: number, text: string, sentence: string) => {
      const own = wordLangAt(line, text);
      const p = pickFor(picks, text, sentence);
      const l = voiceLangOf(p, own);
      return base(l) === base(lang) ? lang : l;
    },
    [wordLangAt, picks, lang],
  );

  // The list catalogue of a word's own language, when it is not the deck's.
  const [extra, setExtra] = useState<ReadonlyMap<string, MeaningIndex>>(() => new Map());
  const need = useCallback(
    (l: string) => {
      if (l === base(normLang) || extra.has(l) || l === "und") return;
      catalogWords(l)
        .then((m) =>
          setExtra((e) => (e.has(l) ? e : new Map(e).set(l, meaningIndex(new Set(m.values()), l)))),
        )
        .catch(() => {});
    },
    [normLang, extra],
  );

  /** The entries of a selection, by language, and the one shown. */
  const senseOf = useCallback(
    (s: SenseSpan | null): WordSense | null => {
      if (!s) return null;
      const own = wordLangAt(s.line, s.text);
      const hits = new Map<SenseEntry, MeaningHit>();
      const look = (l: string, idx: readonly MeaningIndex[]) => {
        if (!idx.length) return;
        const h = matchMeaning(s.toks, s.t0, s.t1, idx, l);
        if (h) hits.set({ lang: l, term: h.m.term, back: h.m.back, reading: h.m.reading }, h);
      };
      const deck = base(normLang);
      if (own !== deck) {
        const x = extra.get(own);
        if (x) look(own, [x]);
      }
      look(deck, meanIdx);
      const entries = [...hits.keys()];
      const view = senseView(entries, own, pickFor(picks, s.text, s.sentence));
      if (!view) return null;
      return { view, hit: hits.get(view.main)! };
    },
    [wordLangAt, normLang, extra, meanIdx, picks],
  );

  return { sayLang, wordLangAt, voiceLang, senseOf, need, pick };
}
