"use client";

// The reader v2's selection card (docs/books-plan.md, "Combo-click expanding
// selection"): ONE glass layer for the selected unit, nothing framed inside
// it (design-principles.md, minimal nesting) — its kind and a preview (title
// and size for a chapter or the book), how well its words are known, the
// actions that fit it, and a link button (our own inline SVG) that copies
// the unit's deep link. Not modal: the book stays clickable under it, so the
// next quick click widens the selection.

import { useEffect } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import type { Fam } from "@/lib/read/reader-model";
import type { FamCounts, Unit } from "@/lib/read/reader-select";
import { fill } from "@/lib/nav/nav-core";

export interface UnitView {
  unit: Unit;
  /** The unit's text (word … paragraph), or null for a chapter or the book. */
  text: string | null;
  /** A chapter's or the book's title. */
  title: string | null;
  /** Real counts for a chapter or the book (design-principles.md: his data, not our numbers). */
  size: { words: number; paras?: number; chapters?: number } | null;
  /** A word's own familiarity; undefined while the word map loads, or off the map. */
  fam?: Fam;
  /** Running words by familiarity; null when not counted (the word map is not here). */
  counts: FamCounts | null;
  /** The server's known share 0–100 for the book (its ring), when counts are not made here. */
  coverage: number | null;
}

export interface CardActions {
  copyLink: () => void;
  copyText?: () => void;
  lookUp?: () => void;
  translate?: () => void;
  readFrom?: () => void;
  markNew?: () => void;
  /** Review every word of the selection's paragraph in /words' review (reader-word-review.tsx). */
  reviewWords?: () => void;
  /** 制卡: `n` words of the paragraph have no card in any of his lists. */
  makeCards?: { n: number; run: () => void };
}

const famClass = (f: Fam): "known" | "learning" | "fresh" | "unrecognised" =>
  f === "k" ? "known" : f === "n" ? "fresh" : f === "u" ? "unrecognised" : "learning";

const SEG = {
  known: "bg-[oklch(0.58_0.14_155)] dark:bg-[oklch(0.76_0.14_155)]",
  learning: "bg-[oklch(0.58_0.14_155/0.45)] dark:bg-[oklch(0.76_0.14_155/0.45)]",
  fresh: "bg-[oklch(0.62_0.12_250/0.55)] dark:bg-[oklch(0.72_0.12_250/0.55)]",
  unrecognised: "bg-[oklch(0.6_0.13_45/0.55)] dark:bg-[oklch(0.74_0.12_45/0.55)]",
} as const;

/** The link mark: two chain links, stroked in the text colour. */
export function LinkIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M10 13.5a4.5 4.5 0 0 0 6.36 0l3.18-3.18a4.5 4.5 0 0 0-6.36-6.36l-1.4 1.4" />
      <path d="M14 10.5a4.5 4.5 0 0 0-6.36 0l-3.18 3.18a4.5 4.5 0 0 0 6.36 6.36l1.4-1.4" />
    </svg>
  );
}

export function SelectCard({
  view,
  actions,
  atTop,
  bottom,
  status,
  onClose,
}: {
  view: UnitView;
  actions: CardActions;
  /** Show it under the top strip (the selection sits low on the screen). */
  atTop: boolean;
  /** CSS bottom offset when at the bottom (clear of the pill and the island). */
  bottom: string;
  /** A short confirmation (copied, noted), or null. */
  status: string | null;
  onClose: () => void;
}) {
  const t = useIntlayer("read-select");
  const tw = useIntlayer("read-words");
  const tr = useIntlayer("read-word-review");
  const { locale } = useLocale();
  const nf = new Intl.NumberFormat(String(locale));
  const pf = new Intl.NumberFormat(String(locale), { style: "percent" });
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const u = view.unit;
  const kind = {
    word: t.kindWord.value,
    phrase: t.kindPhrase.value,
    sentence: t.kindSentence.value,
    para: t.kindParagraph.value,
    chapter: t.kindChapter.value,
    book: t.kindBook.value,
  }[u.kind];
  const label = {
    known: tw.mastered.value,
    learning: tw.learning.value,
    fresh: tw.newWords.value,
    unrecognised: tw.unrecognised.value,
  };
  const c = view.counts;
  const share = c && c.n ? c.known / c.n : view.coverage !== null ? view.coverage / 100 : null;
  const btn =
    "min-h-10 rounded-full px-3 text-sm hover:bg-[oklch(0.5_0_0/0.1)] focus-visible:bg-[oklch(0.5_0_0/0.1)]";

  return (
    <div
      role="region"
      aria-label={kind}
      data-testid="read-select-card"
      data-kind={u.kind}
      className="lk-glass fixed inset-x-3 z-30 mx-auto max-w-[36rem] rounded-2xl border border-[var(--glass-line)] px-4 pt-2 pb-2 shadow-[0_8px_24px_-10px_oklch(0.22_0.015_65/0.4)]"
      style={atTop ? { top: "calc(env(safe-area-inset-top) + 3.5rem)" } : { bottom }}
      // Clicks on the card are not clicks on the book (nor "elsewhere").
      data-select-card
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-70">{kind}</span>
        {u.kind === "word" && view.fam && (
          <span className="flex items-center gap-1 text-xs opacity-80" data-fam={view.fam}>
            <span aria-hidden className={`h-2 w-2 rounded-full ${SEG[famClass(view.fam)]}`} />
            {label[famClass(view.fam)]}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={actions.copyLink}
          aria-label={t.copyLink.value}
          title={t.copyLink.value}
          data-testid="read-select-link"
          className="grid h-10 w-10 place-items-center rounded-full hover:bg-[oklch(0.5_0_0/0.1)]"
        >
          <LinkIcon />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.clear.value}
          title={t.clear.value}
          data-testid="read-select-close"
          className="grid h-10 w-10 place-items-center rounded-full text-lg opacity-70"
        >
          ×
        </button>
      </div>

      {view.title !== null && (
        <p className="truncate text-base font-medium" data-testid="read-select-title">
          {view.title}
        </p>
      )}
      {view.size && (
        <p className="text-xs tabular-nums opacity-70" data-testid="read-select-size">
          {view.size.chapters !== undefined
            ? fill(t.bookSize.value, {
                words: nf.format(view.size.words),
                chapters: nf.format(view.size.chapters),
              })
            : fill(t.chapterSize.value, {
                words: nf.format(view.size.words),
                paras: nf.format(view.size.paras ?? 0),
              })}
        </p>
      )}
      {view.text !== null && (
        <p
          className={`${u.kind === "word" ? "text-lg font-medium" : "line-clamp-3 text-sm opacity-90"}`}
          data-testid="read-select-text"
        >
          {view.text.trim()}
        </p>
      )}

      {u.kind !== "word" && share !== null && (
        <div className="mt-1.5 flex items-center gap-2" data-testid="read-select-fam">
          {c && c.n > 0 && (
            <div
              aria-hidden
              className="flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[oklch(0.5_0_0/0.12)]"
            >
              {(["known", "learning", "fresh", "unrecognised"] as const).map((k) =>
                c[k] ? (
                  <span key={k} className={SEG[k]} style={{ width: `${(c[k] / c.n) * 100}%` }} />
                ) : null,
              )}
            </div>
          )}
          <span className="text-xs tabular-nums opacity-75">
            {fill(t.knownShare.value, { pct: pf.format(share) })}
          </span>
        </div>
      )}

      <div
        className="-mx-2 mt-1 flex flex-wrap items-center gap-x-1"
        data-testid="read-select-actions"
      >
        {actions.reviewWords && (
          <button
            type="button"
            className={`${btn} font-medium`}
            onClick={actions.reviewWords}
            data-action="review-words"
          >
            {t.reviewWords}
          </button>
        )}
        {actions.makeCards && (
          <button
            type="button"
            className={btn}
            onClick={actions.makeCards.run}
            data-action="make-cards"
          >
            {fill(tr.makeCards.value, { n: nf.format(actions.makeCards.n) })}
          </button>
        )}
        {actions.lookUp && (
          <button type="button" className={btn} onClick={actions.lookUp} data-action="lookup">
            {t.lookUp}
          </button>
        )}
        {actions.translate && (
          <button type="button" className={btn} onClick={actions.translate} data-action="translate">
            {t.translate}
          </button>
        )}
        {actions.markNew && (
          <button type="button" className={btn} onClick={actions.markNew} data-action="mark-new">
            {t.markNew}
          </button>
        )}
        {actions.readFrom && (
          <button type="button" className={btn} onClick={actions.readFrom} data-action="read-from">
            {t.readFromHere}
          </button>
        )}
        {actions.copyText && (
          <button type="button" className={btn} onClick={actions.copyText} data-action="copy-text">
            {t.copyText}
          </button>
        )}
        {status && (
          <span role="status" className="px-2 text-xs opacity-75" data-testid="read-select-status">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
