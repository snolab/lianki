"use client";

// Reviewing a paragraph's words from the reader v2 (docs/books-plan.md,
// "Review a range's words"; owner, 2026-11-03 22:19–22:27 JST): the
// selection card's 「复习该段落所有单词」 opens /words' own list review (the
// Study of WordsClient: its rows, swipe, mirror, undo, marks, FSRS cards)
// over the book, given only the paragraph's words — each on his existing
// card when any of his lists has it, else as a new word of the book's list
// (POST /api/read/[id]/word-session). 「制卡」 makes a card for each word that
// has none (POST /api/read/[id]/make-cards), with an undo toast.
//
// The overlay covers the reader; the page under it keeps its place, and
// closing (✕, the exit button, back) returns focus to the reader.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useIntlayer } from "next-intlayer";
import { catalogWords, type CatalogWord } from "@/lib/read/dict";
import type { Sentence } from "@/lib/read/reader-model";
import { orderWords, type ParaWord } from "@/lib/read/word-review";
import { foldsOf } from "@/lib/read/words";
import { fill } from "@/lib/nav/nav-core";
import { useBackToClose } from "@/lib/use-back-to-close";
import type { WordList } from "@/lib/repos/wordsD1";
import type { StudyScope } from "@/app/(app)/words/WordsClient";

type StudyProps = {
  lists: WordList[];
  onExit: () => void;
  scope: StudyScope;
};
/** One array for every render: Study reloads its queue when `catalog` changes. */
const NO_CATALOG: never[] = [];
// /words' study with its own config, loaded only when the review opens.
const Study = dynamic<StudyProps>(
  () =>
    import("@/app/(app)/words/WordsClient").then((m) => {
      const Scoped = (p: StudyProps) => (
        <m.Study {...p} config={m.WORDS} catalog={NO_CATALOG} voice="off" title="" />
      );
      return Scoped;
    }),
  { ssr: false },
);

/** A word as the review endpoints take it: its sentence, and the catalog's meaning if any. */
export type RangeWord = {
  w: string;
  ex: string | null;
  term: string | null;
  reading: string | null;
  back: string | null;
};

/** The words of a range for the endpoints, unknown ones first (lib/read/word-review.ts). */
export async function rangeWordsOf(
  words: readonly ParaWord[],
  sentences: readonly Sentence[],
  normLang: string,
): Promise<RangeWord[]> {
  const cat = await catalogWords(normLang).catch(() => new Map<string, CatalogWord>());
  const { first, rest } = orderWords(words);
  return [...first, ...rest].map((x) => {
    let m: CatalogWord | undefined;
    for (const f of foldsOf(x.w, normLang)) if ((m = cat.get(f))) break;
    return {
      w: x.w,
      ex: sentences[x.s]?.text.trim() || null,
      term: m?.term ?? null,
      reading: m?.reading ?? null,
      back: m?.back ?? null,
    };
  });
}

const post = <T,>(url: string, body: unknown): Promise<T> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))));

/** 制卡: cards for the range's words that have none; resolves to the terms made. */
export const makeCards = (id: string, words: RangeWord[]) =>
  post<{ listId: string | null; terms: string[] }>(`/api/read/${id}/make-cards`, { words });
export const unmakeCards = (id: string, terms: string[]) =>
  post<{ removed: number }>(`/api/read/${id}/make-cards`, { undo: terms });

/**
 * A new word of the book's list was just graded: its meaning and sentence
 * join the list. The grade syncs through /words' queue; the entry is added
 * once the card is there (a few tries, then the next review backfills it).
 */
export function addGradedWord(id: string, w: RangeWord) {
  const tryAdd = (n: number) =>
    post<{ added: number }>(`/api/read/${id}/word-session`, { graded: [w] })
      .then((r) => r.added > 0 || Promise.reject(new Error("not yet")))
      .catch(() => n < 3 && setTimeout(() => tryAdd(n + 1), 1000 * 3 ** n));
  setTimeout(() => tryAdd(0), 800);
}

/** Opens a range's words in /words' terms (each on his card, or new in the book's list). */
export const wordSession = (id: string, words: RangeWord[]) =>
  post<{ items: StudyScope["items"]; lists: WordList[]; missing: string[] }>(
    `/api/read/${id}/word-session`,
    { words },
  );

/** The toast after 制卡: how many, and Undo (glass, over the bottom of the screen). */
export function MadeToast({
  text,
  undoLabel,
  onUndo,
  onDone,
}: {
  text: string;
  undoLabel?: string;
  onUndo?: () => void;
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [onDone, text]);
  return (
    <div
      role="status"
      data-testid="read-made-toast"
      className="lk-glass fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[var(--lk-z-overlay-toast)] mx-auto flex max-w-[28rem] items-center gap-2 rounded-full border border-[var(--glass-line)] px-4 py-1.5 text-sm shadow-[0_8px_24px_-10px_oklch(0.22_0.015_65/0.4)]"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {onUndo && (
        <button
          type="button"
          onClick={() => {
            onUndo();
            onDone();
          }}
          className="min-h-10 rounded-full px-3 font-medium hover:bg-[oklch(0.5_0_0/0.1)]"
        >
          {undoLabel}
        </button>
      )}
    </div>
  );
}

type Session = { items: StudyScope["items"]; lists: WordList[]; missing: string[] };

export function WordReview({
  id,
  title,
  words,
  returnTo,
  onClose,
  onChanged,
}: {
  id: string;
  title: string;
  words: RangeWord[];
  /** Focused again on close. */
  returnTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Cards were made or graded here (called once, on close): the reader refreshes its marks. */
  onChanged: () => void;
}) {
  const t = useIntlayer("read-word-review");
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);
  const [v, setV] = useState(0);
  const [toast, setToast] = useState<{ text: string; terms?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const changed = useRef(false);
  const close = useRef(onClose);
  close.current = () => {
    if (changed.current) onChanged();
    onClose();
  };
  const touched = useCallback(() => {
    changed.current = true;
  }, []);
  useBackToClose(true, () => close.current());

  useLayoutEffect(() => {
    const back = returnTo.current;
    panel.current?.focus({ preventScroll: true });
    return () => back?.focus({ preventScroll: true });
  }, [returnTo]);

  useEffect(() => {
    let live = true;
    post<Session>(`/api/read/${id}/word-session`, { words })
      .then((s) => {
        if (!live) return;
        setSession(s);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id, words, v]);

  const byTerm = useRef(new Map<string, RangeWord>());
  useEffect(() => {
    const m = new Map<string, RangeWord>();
    for (const it of session?.items ?? []) {
      const w = words.find((x) => x.w === (it as { w?: string }).w);
      if (w) m.set(`${it.listId}\u0000${it.term}`, w);
    }
    byTerm.current = m;
  }, [session, words]);

  const onGrade = useCallback(
    (listId: string, term: string, isNew: boolean) => {
      touched();
      // A new word of the book's list: its meaning and sentence join the list.
      const w = byTerm.current.get(`${listId}\u0000${term}`);
      if (!isNew || !w) return;
      addGradedWord(id, w);
    },
    [id, touched],
  );

  const make = () => {
    setBusy(true);
    makeCards(id, words)
      .then((r) => {
        setToast({ text: fill(t.madeCards.value, { n: String(r.terms.length) }), terms: r.terms });
        touched();
        setV((x) => x + 1);
      })
      .catch(() => setToast({ text: t.makeFailed.value }))
      .finally(() => setBusy(false));
  };

  const missing = session?.missing.length ?? 0;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      data-testid="read-word-review"
      className="fixed inset-0 z-[var(--lk-z-overlay)] isolate bg-[var(--background)] outline-none"
    >
      {/* The top band /words' toolbar sits under: the paragraph's title, 制卡, ✕. */}
      <div className="lk-glass fixed inset-x-0 top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end border-b border-[var(--glass-line)] px-3 pb-1">
        <div className="flex w-full items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          {missing > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={make}
              data-testid="read-review-make"
              className="min-h-10 rounded-full px-3 text-sm font-medium hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-50"
            >
              {fill(t.makeCards.value, { n: String(missing) })}
            </button>
          )}
          <button
            type="button"
            onClick={() => close.current()}
            aria-label={t.close.value}
            title={t.close.value}
            data-testid="read-review-close"
            className="grid h-10 w-10 place-items-center rounded-full text-lg opacity-70"
          >
            ×
          </button>
        </div>
      </div>
      {session ? (
        <Study
          key={v}
          lists={session.lists}
          onExit={() => close.current()}
          scope={{ items: session.items, onGrade, exitLabel: t.backToBook.value }}
        />
      ) : (
        <p className="px-4 pt-[calc(5rem+env(safe-area-inset-top))] text-sm opacity-70">
          {failed ? t.loadFailed : t.loading}
        </p>
      )}
      {toast && (
        <MadeToast
          text={toast.text}
          undoLabel={t.undo.value}
          onUndo={
            toast.terms?.length
              ? () =>
                  void unmakeCards(id, toast.terms!)
                    .then(() => {
                      touched();
                      setV((x) => x + 1);
                    })
                    .catch(() => {})
              : undefined
          }
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}
