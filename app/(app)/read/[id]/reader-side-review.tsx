"use client";

// The reader's side-by-side word review (docs/books-plan.md, "Side-by-side
// word review"; owner, 2026-11-04 15:56 JST; flag `read.side-review`). The
// book stays on screen; ONE /words card sits beside it (a wide screen) or
// over the bottom of the book (a phone), for the word focused in the text.
// D / N jump to the next due / new word of the text (Shift: back); the card
// reveals with Space, grades with /words' keys (1–4, L K J H) through
// /words' own pending queue, and Z undoes. After a grade the reader moves to
// the next word of the same kind.
//
// Loaded only when the review opens (it pulls in /words' client module).
// No gesture starts at a screen edge (Android's Back): the card is inset and
// graded by buttons and keys.

import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { queueWordReview, queueWordUndo } from "@/app/(app)/words/WordsClient";
import { keyRating } from "@/lib/words/swipe";
import type { WordList } from "@/lib/repos/wordsD1";
import { fill } from "@/lib/nav/nav-core";
import { formatInterval, parseCard } from "@/lib/words/schedule";
import { sideCardOf, type SideKind } from "@/lib/read/side-review";
import type { Fam } from "@/lib/read/reader-model";
import { SEG, famClass } from "./reader-select-card";
import { addGradedWord, makeCards, wordSession, type RangeWord } from "./reader-word-review";

type Rating = 1 | 2 | 3 | 4;

/** The focused word: where it is, its form, its sentence and the catalog's meaning. */
export type SideFocus = {
  line: number;
  t: number;
  w: string;
  /** Why it is here (a jump's kind), or null for a word he clicked. */
  kind: SideKind | null;
  word: RangeWord;
};

/**
 * A paragraph's (or a selection's) words, shown above the card on PC (owner,
 * 2026-11-04 19:31 JST: 本段单词 beside the text): each with its place in
 * the text and his familiarity.
 */
export type SideList = {
  title: string;
  items: { w: string; text: string; line: number; t: number; fam?: Fam }[];
};
type ListItem = SideList["items"][number] & { due: boolean; grade?: Rating };

/** What a grade leaves for the reader's undo. */
export type SideGrade = { listId: string; term: string };

type Card = {
  listId: string;
  term: string;
  reading: string | null;
  back: string;
  ex: string | null;
  card: string | null;
  cursor: number;
};

export default function SideReview({
  id,
  focus,
  none,
  say,
  onJump,
  onGraded,
  onUndo,
  onClose,
  list = null,
  onPick,
}: {
  id: string;
  focus: SideFocus | null;
  /** No word of either kind from here on. */
  none: boolean;
  say: (text: string) => void;
  onJump: (kind: SideKind, dir: 1 | -1) => void;
  onGraded: (f: SideFocus, g: SideGrade, rating: Rating) => void;
  /** The last grade here to take back, or null. */
  onUndo: () => SideGrade | null;
  onClose: () => void;
  /** The paragraph's words (PC), above the card; null: the text's due / new words. */
  list?: { title: string; items: ListItem[] } | null;
  onPick?: (x: ListItem) => void;
}) {
  const tr = useIntlayer("read-words");
  const t = useIntlayer("read-side-review");
  const tw = useIntlayer("words-page");
  const [card, setCard] = useState<Card | null>(null);
  /** The request failed (offline, a server error): a retry is offered. */
  const [failed, setFailed] = useState(false);
  /** No card can be offered for this word (not one of the book's counted words, a name): 制卡. */
  const [cardless, setCardless] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped to load the card again (retry, after 制卡). */
  const [v, setV] = useState(0);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    setCard(null);
    setFailed(false);
    setCardless(false);
    shownAt.current = Date.now();
    if (!focus) return;
    let live = true;
    // His card even when not due yet: a word he clicked opens whatever its due.
    wordSession(id, [focus.word], true)
      .then((s) => {
        if (!live) return;
        const got = sideCardOf(s.items as ((typeof s.items)[number] & { w?: string })[], focus.w);
        if (got.kind === "cardless") return setCardless(true);
        const it = got.item;
        const list: WordList | undefined = s.lists.find((l) => l.id === it.listId);
        setCard({
          listId: it.listId,
          term: it.term,
          reading: it.reading ?? null,
          back: it.back,
          ex: it.ex ?? null,
          card: it.card ?? null,
          cursor: list?.cursor ?? 0,
        });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id, focus, v]);

  /** 制卡 for a word with no card to offer: then its card is loaded. */
  const make = () => {
    if (!focus) return;
    setBusy(true);
    makeCards(id, [focus.word])
      .then(() => setV((x) => x + 1))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  const grade = (r: Rating) => {
    if (!focus || !card) return;
    void queueWordReview(card, r, Date.now() - shownAt.current);
    // A new word of the book's list: its meaning and sentence join the list.
    if (!card.card) addGradedWord(id, focus.word);
    onGraded(focus, { listId: card.listId, term: card.term }, r);
  };

  const live = useRef({ grade, onJump, onUndo, onClose, say, card });
  live.current = { grade, onJump, onUndo, onClose, say, card };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (document.querySelector("[aria-modal=true]")) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const L = live.current;
      // Holding a key repeats jumps only, never a grade or an undo (as /words).
      if (e.repeat && e.code !== "KeyD" && e.code !== "KeyN") return e.preventDefault();
      if (e.code === "KeyD") L.onJump("due", e.shiftKey ? -1 : 1);
      else if (e.code === "KeyN") L.onJump("new", e.shiftKey ? -1 : 1);
      else if (e.code === "KeyZ" || e.code === "Backspace") {
        const g = L.onUndo();
        if (g) void queueWordUndo(g.listId, g.term);
      } else if (e.code === "Escape") L.onClose();
      else if (keyRating(e)) L.grade(keyRating(e)!);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);

  const due = card?.card ? (parseCard(card.card)?.due.getTime() ?? null) : null;
  const status = !card
    ? null
    : !card.card
      ? tw.statusNew.value
      : due !== null && due <= Date.now()
        ? fill(tw.ago.value, { t: formatInterval(Date.now() - due) })
        : t.notDue.value;
  const grades: [Rating, string][] = [
    [1, tw.again.value],
    [2, tw.hard.value],
    [3, tw.good.value],
    [4, tw.easy.value],
  ];
  const nav = (kind: SideKind, label: string) => (
    <div className="flex items-center">
      <button
        type="button"
        onClick={() => onJump(kind, -1)}
        aria-label={fill(t.prev.value, { kind: label })}
        title={fill(t.prev.value, { kind: label })}
        data-testid={`side-prev-${kind}`}
        className="grid h-10 w-10 place-items-center rounded-full hover:bg-[oklch(0.5_0_0/0.1)]"
      >
        ‹
      </button>
      <span className="px-1 text-xs opacity-75">{label}</span>
      <button
        type="button"
        onClick={() => onJump(kind, 1)}
        aria-label={fill(t.next.value, { kind: label })}
        title={fill(t.next.value, { kind: label })}
        data-testid={`side-next-${kind}`}
        className="grid h-10 w-10 place-items-center rounded-full hover:bg-[oklch(0.5_0_0/0.1)]"
      >
        ›
      </button>
    </div>
  );

  return (
    <aside
      aria-label={t.open.value}
      data-testid="read-side-review"
      // Phone: over the bottom of the book, above the pill; wide: beside it.
      className="lk-glass fixed inset-x-3 z-30 flex max-h-[45vh] flex-col gap-2 overflow-y-auto overscroll-contain rounded-2xl border border-[var(--glass-line)] bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] p-3 shadow-[0_8px_24px_-10px_oklch(0.22_0.015_65/0.4)] lg:inset-x-auto lg:end-4 lg:top-16 lg:bottom-auto lg:max-h-[calc(100vh-6rem)] lg:w-[calc(var(--lk-side-w)-2rem)]"
      // Text runs under it: the near-opaque glass keeps it legible (as the reader's strip).
      style={{ background: "var(--glass-bg-solid)" }}
    >
      <div className="flex items-center gap-1">
        {nav("due", t.due.value)}
        {nav("new", t.fresh.value)}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close.value}
          title={t.close.value}
          data-testid="side-close"
          className="grid h-10 w-10 place-items-center rounded-full text-lg opacity-70"
        >
          ×
        </button>
      </div>

      {list && (
        <section aria-label={list.title} data-testid="side-list" className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{list.title}</h2>
          <ul className="flex max-h-[38vh] flex-col overflow-y-auto overscroll-contain">
            {list.items.map((x) => {
              const f = x.fam ? famClass(x.fam) : null;
              const on = focus?.w === x.w;
              const grade = x.grade ? grades.find(([r]) => r === x.grade)?.[1] : null;
              return (
                <li key={x.w}>
                  <button
                    type="button"
                    onClick={(e) => {
                      // The keys stay the card's (Space reveals), not this button's.
                      e.currentTarget.blur();
                      onPick?.(x);
                    }}
                    aria-current={on ? "true" : undefined}
                    data-side-item={x.w}
                    className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-start text-sm ${
                      on
                        ? "bg-[oklch(0.5_0_0/0.12)] font-semibold"
                        : "hover:bg-[oklch(0.5_0_0/0.07)]"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${f ? SEG[f] : "bg-[oklch(0.5_0_0/0.2)]"}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{x.text}</span>
                    <span className="shrink-0 text-xs opacity-70">
                      {grade ??
                        (x.due
                          ? t.due.value
                          : f === "learning"
                            ? t.notDue.value
                            : f === "known"
                              ? tr.mastered.value
                              : f === "fresh"
                                ? tr.newWords.value
                                : f === "unrecognised"
                                  ? tr.unrecognised.value
                                  : "")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!focus ? (
        <p className="text-sm opacity-70">{none ? t.none : t.loading}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <h2 className="min-w-0 flex-1 text-2xl font-semibold break-words" data-side-term>
              {card?.term ?? focus.word.w}
            </h2>
            <button
              type="button"
              onClick={() => say(card?.term ?? focus.word.w)}
              aria-label={t.say.value}
              title={t.say.value}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-[oklch(0.5_0_0/0.1)]"
            >
              <span aria-hidden>🔊</span>
            </button>
          </div>
          {card?.reading && <p className="-mt-1 text-sm opacity-75">{card.reading}</p>}
          <p className="flex items-center gap-2 text-xs opacity-70" data-side-status>
            {failed ? t.loadFailed : cardless ? t.noCard : (status ?? t.loading)}
            {failed && (
              <button
                type="button"
                onClick={() => setV((x) => x + 1)}
                data-testid="side-retry"
                className="min-h-8 rounded-full px-2 font-medium underline"
              >
                {t.retry}
              </button>
            )}
          </p>
          {/* Everything shown at once (owner, 19:53 JST): he reads it and grades. */}
          {(card?.back || (!card && focus.word.back)) && (
            <p className="whitespace-pre-line text-base" data-side-back>
              {card?.back || focus.word.back}
            </p>
          )}
          {(card?.ex || (!card && focus.word.ex)) && (
            <p className="text-sm italic opacity-75">{card?.ex || focus.word.ex}</p>
          )}
          {cardless && (
            <button
              type="button"
              disabled={busy}
              onClick={make}
              data-testid="side-make"
              className="min-h-10 self-start rounded-full px-3 text-sm font-medium hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-50"
            >
              {t.makeCard}
            </button>
          )}
          <div className="grid grid-cols-4 gap-1" role="group">
            {grades.map(([r, label]) => (
              <button
                key={r}
                type="button"
                disabled={!card}
                onClick={() => grade(r)}
                data-grade={r}
                data-testid={`side-grade-${r}`}
                className="min-h-10 rounded-full px-1 text-sm font-medium hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-40"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <p className="hidden text-xs opacity-60 lg:block">{t.keys}</p>
    </aside>
  );
}
