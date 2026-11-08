"use client";

// Reviewing a paragraph's words from the reader v2 (docs/books-plan.md,
// "Review a range's words"; owner, 2026-11-03 22:19–22:27 JST): the
// selection card's 「复习该段落所有单词」 opens /words' own list review (the
// Study of WordsClient: its rows, swipe, mirror, undo, marks, FSRS cards)
// over the book, given only the paragraph's words — each on his existing
// card when any of his lists has it, else as a new word of the book's list
// (POST /api/read/[id]/word-session). A new word is a row that stores nothing
// until a swipe grades it (owner, 2026-11-06). 「制卡」 is only the batch: with
// several words missing, a card for each (POST /api/read/[id]/make-cards), with
// an undo toast. A row near the screen gets its meaning and its example's
// translation by itself (lib/read/review-row-fill.ts), the same asks as a tap.
//
// A bottom sheet over the reader (owner, 2026-11-09 00:51 JST: not full
// screen): it slides up, leaves a gap at the top where the book stays in
// view, and its top band drags it taller, shorter or away (use-review-sheet.ts,
// lib/read/review-sheet.ts). The page under it keeps its place, and closing
// (✕, the exit button, Escape, a tap above it, back) returns focus to the reader.
//
// It is pinned in the URL (`?review=<ref>`, lib/read/review-ref.ts): opening
// pushes one entry with that address, so Back closes it and a refresh or a
// link opens it again; the card in focus and the list's scroll are kept per
// tab (`lk:ui:words`, under `reviewKey`). docs/ui-state.md.

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { activeByok } from "@/lib/byok/config";
import { catalogWords, type CatalogWord } from "@/lib/read/dict";
import type { Sentence } from "@/lib/read/reader-model";
import { MIN_BATCH, orderWords, type ParaWord } from "@/lib/read/word-review";
import { foldsOf } from "@/lib/read/words";
import { createRowFill } from "@/lib/read/review-row-fill";
import { fetchCachedGloss, fetchGloss } from "@/lib/read/select-gloss-fetch";
import { fetchPiece } from "@/lib/read/select-translate-fetch";
import { readNotesOn } from "@/lib/read/translator-notes";
import { fill } from "@/lib/nav/nav-core";
import { useBackToClose } from "@/lib/use-back-to-close";
import type { BackOptions } from "@/lib/back-to-close";
import type { WordList } from "@/lib/repos/wordsD1";
import type { StudyScope } from "@/app/(app)/words/WordsClient";
import { SHEET_EASE, useReviewSheet } from "./use-review-sheet";

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
  place,
  pin,
  cachedOnly = false,
}: {
  id: string;
  title: string;
  words: RangeWord[];
  /** A /vibe doc's private speech: its meanings ask no model before a swipe (docs/vibe.md). */
  cachedOnly?: boolean;
  /** Where this review's position is kept in the tab (reviewKey). */
  place?: string;
  /** Its history entry: the address with `?review=`, or the one it was opened from. */
  pin?: BackOptions;
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
  useBackToClose(true, () => close.current(), pin);
  // A bottom sheet over the book (owner, 2026-11-09 00:51 JST): ✕, the exit
  // button, Escape and a tap above it slide it down first.
  const sheet = useReviewSheet(() => close.current());

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

  const { locale } = useLocale();
  const to = String(locale);
  // Read when the review opens, as a selection reads them when it changes.
  const own = useMemo(() => (cachedOnly ? null : activeByok()), [cachedOnly]);
  const rowFill = useMemo(() => {
    const ownNow = activeByok();
    const notes = readNotesOn();
    return createRowFill({
      to,
      // The new words only: a card has its meaning, or the session looked for one.
      wordOf: (listId, term) => byTerm.current.get(`${listId}\u0000${term}`),
      gloss: (w, ex) => (cachedOnly ? fetchCachedGloss(id, w, ex) : fetchGloss(id, w, ex, own)),
      // The reader's own path: the shared cache and its charge, his own AI, or
      // a /vibe doc's private path (the route tells).
      translate: (text, lang) =>
        fetchPiece(id, to, lang && lang !== "und" ? lang : undefined, text, ownNow, notes),
    });
  }, [id, to, own, cachedOnly]);

  const onGrade = useCallback(
    (listId: string, term: string, isNew: boolean) => {
      touched();
      // A new word of the book's list: its meaning and sentence join the list.
      const w = byTerm.current.get(`${listId}\u0000${term}`);
      if (!isNew || !w) return;
      // Asked for it already (or asking now): the commit carries that answer and
      // pays for nothing again. `own`: no model of ours, even with no answer.
      const found = rowFill.meaningOf(listId, term);
      // The grade syncs through /words' queue; its entry is added once the
      // card is there (a few tries, then the next review backfills it).
      const tryAdd = (n: number) =>
        Promise.resolve(found)
          .then((g) =>
            post<{ added: number }>(`/api/read/${id}/word-session`, {
              graded: [g?.back ? { ...w, term: w.term ?? g.term, back: g.back } : w],
              ...(own ? { own: true } : {}),
            }),
          )
          .then((r) => r.added > 0 || Promise.reject(new Error("not yet")))
          .catch(() => n < 3 && setTimeout(() => tryAdd(n + 1), 1000 * 3 ** n));
      setTimeout(() => tryAdd(0), 800);
    },
    [id, touched, rowFill, own],
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
    <>
      {/* The text above the sheet stays in view, a shade dimmer; a tap there closes it. */}
      <div
        aria-hidden
        data-testid="read-review-scrim"
        className="fixed inset-0 z-[var(--lk-z-overlay)] bg-[oklch(0.2_0.01_65/0.12)] transition-opacity duration-300 motion-reduce:transition-none dark:bg-[oklch(0_0_0/0.25)]"
        style={{ opacity: sheet.shown ? 1 : 0 }}
        onClick={() => sheet.dismiss()}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid="read-word-review"
        data-sheet-h={sheet.h}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) sheet.dismiss();
        }}
        // A bottom sheet (lib/read/review-sheet.ts): its transform makes it the
        // containing block of /words' fixed list, toolbar and strips, so they
        // fill the sheet, not the window.
        className="fixed inset-x-0 bottom-0 z-[var(--lk-z-overlay)] isolate mx-auto max-w-[56rem] overflow-hidden rounded-t-2xl border border-b-0 border-[var(--glass-line)] bg-[var(--background)] shadow-[0_-12px_40px_-12px_oklch(0.22_0.015_65/0.45)] outline-none"
        style={
          {
            height: sheet.height,
            transform: `translateY(${sheet.offset})`,
            transition: sheet.dragging ? "none" : SHEET_EASE,
            "--lk-sheet-inset-top": "0px",
            "--nav-w": "0px",
          } as CSSProperties
        }
      >
        {/* The top band /words' toolbar sits under: the grab handle, the
          paragraph's title, 制卡, ✕. Dragging it resizes or closes the sheet. */}
        <div
          className="lk-glass fixed inset-x-0 top-0 z-30 flex h-14 touch-none items-end border-b border-[var(--glass-line)] px-3 pb-1 select-none"
          data-testid="read-review-grab"
          onPointerDown={sheet.down}
          onPointerMove={sheet.move}
          onPointerUp={sheet.up}
          onPointerCancel={sheet.cancel}
        >
          <span
            aria-hidden
            className="absolute top-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-[oklch(0.5_0.01_65/0.45)]"
          />
          <div className="flex w-full items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
            {missing >= MIN_BATCH && (
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
              onClick={() => sheet.dismiss()}
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
            onExit={() => sheet.dismiss()}
            scope={{
              items: session.items,
              onGrade,
              exitLabel: t.backToChapter.value,
              key: place,
              fill: rowFill,
              // Every row one line taller than /words' (owner, 2026-11-08 19:16 JST).
              extraLines: 1,
            }}
          />
        ) : (
          <p className="px-4 pt-20 text-sm opacity-70">{failed ? t.loadFailed : t.loading}</p>
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
    </>
  );
}
