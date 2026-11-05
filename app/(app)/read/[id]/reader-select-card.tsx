"use client";

// The reader v2's selection card (docs/books-plan.md, "Combo-click expanding
// selection"): ONE glass layer for the selected unit, nothing framed inside
// it (design-principles.md, minimal nesting) — its kind and a preview (title
// and size for a chapter or the book), how well its words are known, the
// actions that fit it, and an icon group (read aloud, copy the text,
// copy the unit's deep link). A word or phrase that is one of his /words cards
// shows the card's meaning at once (lib/read/select-meaning.ts), any other
// word its gloss (use-select-gloss.ts); a phrase, a sentence, a paragraph or
// a hand-made range shows its translation by itself, unit by unit as each
// lands (lib/read/select-translate.ts). No Look up or Translate buttons
// (owner, 2026-11-05 02:11 JST): the rest of a long translation comes as he
// scrolls it, and a failure's error line is its retry. Not modal: the book stays clickable under it, so the
// next quick click widens the selection.

import { useEffect, useRef, type ReactNode } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import type { Fam } from "@/lib/read/reader-model";
import type { FamCounts, Unit } from "@/lib/read/reader-select";
import { fill } from "@/lib/nav/nav-core";
import { CardIcons } from "./reader-card-icons";
import { langLabel } from "@/lib/read/sense-pick";

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
  readFrom?: () => void;
  /** Say exactly the selected text (a hand-made selection). */
  readAloud?: () => void;
  /** Review every word of the selection's paragraph (a range: its own words) in /words' review (reader-word-review.tsx). */
  reviewWords?: () => void;
  /** 制卡: `n` words of the paragraph have no card in any of his lists. */
  makeCards?: { n: number; run: () => void };
  /** A card for the selected phrase, in the book's own deck (the same path as a word's). */
  makePhrase?: () => void;
}

/** A deck card's meaning on the card. */
export interface CardMeaning {
  term: string;
  back: string;
  /** The card is not the selected text itself (a phrase around it, or one inside it). */
  other: boolean;
  /** The entry's language (lib/read/sense-pick.ts). */
  lang?: string;
  /** It is another language's entry than the word's own: labelled with its language. */
  cross?: boolean;
  /** He picked it among several languages' entries. */
  picked?: boolean;
  /** This entry as a pick (lib/read/sense-pick.ts choiceOf). */
  choice?: string;
  /** Other languages' entries for the same text, to pick the one meant here. */
  others?: { lang: string; term: string; back: string; choice: string }[];
  /** Made by the user's own AI from this browser (docs/byok.md): tagged on the card. */
  own?: boolean;
}

/** An inflected word: the form in the book and its dictionary headword (the lemma file). */
export interface CardLemma {
  form: string;
  lemma: string;
  /** The /words list holding his lemma card; null when he has none (制作卡片 makes it). */
  href: string | null;
  /** A grammatical label ("simple past · 3sg"), once the lemma file carries tags. */
  tags?: string | null;
}

/**
 * The translation, a block per paragraph and a part per unit (sentence or
 * paragraph): its text, null while it comes, false when it is not there
 * (failed, or past what is translated by itself).
 */
export interface CardTranslation {
  blocks: (string | null | false)[][];
  /** Asked of the user's own AI from this browser (docs/byok.md): tagged on the card. */
  own?: boolean;
}

/** The tag on a result the user's own AI made: no credits, nothing shared. */
function OwnKeyTag({ label }: { label: ReactNode }) {
  return (
    <span
      className="ms-1.5 inline-block rounded-full bg-[oklch(0.62_0.12_250/0.14)] px-1.5 align-middle text-[0.7rem] leading-5 text-[oklch(0.45_0.12_250)] dark:bg-[oklch(0.72_0.12_250/0.18)] dark:text-[oklch(0.8_0.1_250)]"
      data-testid="read-select-own-key"
    >
      {label}
    </span>
  );
}

/** A deck meaning as plain text: imported decks may carry line breaks as markup. */
export const plainBack = (back: string) =>
  back
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();

const famClass = (f: Fam): "known" | "learning" | "fresh" | "unrecognised" =>
  f === "k" ? "known" : f === "n" ? "fresh" : f === "u" ? "unrecognised" : "learning";

const SEG = {
  known: "bg-[oklch(0.58_0.14_155)] dark:bg-[oklch(0.76_0.14_155)]",
  learning: "bg-[oklch(0.58_0.14_155/0.45)] dark:bg-[oklch(0.76_0.14_155/0.45)]",
  fresh: "bg-[oklch(0.62_0.12_250/0.55)] dark:bg-[oklch(0.72_0.12_250/0.55)]",
  unrecognised: "bg-[oklch(0.6_0.13_45/0.55)] dark:bg-[oklch(0.74_0.12_45/0.55)]",
} as const;

/** A scroller shown to (about) its end. */
const nearEnd = (el: HTMLElement) => el.scrollTop + el.clientHeight >= el.scrollHeight - 24;

export function SelectCard({
  view,
  actions,
  atTop,
  bottom,
  status,
  translation = null,
  meaning = null,
  lemma = null,
  onMoreTranslation = null,
  translateFailed = null,
  onPickSense = null,
  grade = null,
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
  /** The text's translation, or null when there is none to show. */
  translation?: CardTranslation | null;
  /** The deck card the selection is, or covers. */
  meaning?: CardMeaning | null;
  /** The selected word's dictionary form, when it is an inflected one. */
  lemma?: CardLemma | null;
  /** Ask for the next stretch of a long selection's translation (null: nothing left). */
  onMoreTranslation?: (() => void) | null;
  /** The translation failed: its error line is the retry (null: it did not). */
  translateFailed?: (() => void) | null;
  /** He picked another language's entry as the meaning here (its choice, lib/read/sense-pick.ts). */
  onPickSense?: ((choice: string) => void) | null;
  /** The grade handle (or 制卡 / when it is due), under the actions (reader-grade-handle.tsx). */
  grade?: ReactNode;
  onClose: () => void;
}) {
  const t = useIntlayer("read-select");
  const tw = useIntlayer("read-words");
  const tr = useIntlayer("read-word-review");
  const { locale } = useLocale();
  const nf = new Intl.NumberFormat(String(locale));
  const pf = new Intl.NumberFormat(String(locale), { style: "percent" });
  // The rest of a long translation comes by itself (no Translate button):
  // when what came fits without scrolling, or he scrolls it to its end.
  const transRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transRef.current;
    if (onMoreTranslation && el && nearEnd(el)) onMoreTranslation();
  }, [onMoreTranslation, translation]);
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
    range: t.kindSelection.value,
  }[u.kind];
  const label = {
    known: tw.mastered.value,
    learning: tw.learning.value,
    fresh: tw.newWords.value,
    unrecognised: tw.unrecognised.value,
  };
  const c = view.counts;
  /** The meaning can be picked here: another language's, or one of several (sense-pick.ts). */
  const mayPick =
    !!meaning &&
    !meaning.picked &&
    (!!meaning.others?.length || (!!meaning.cross && !!onPickSense));
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
        <CardIcons
          items={[
            ...(actions.readAloud
              ? [
                  {
                    action: "read-aloud",
                    icon: "speakerHigh" as const,
                    label: t.readAloud.value,
                    run: actions.readAloud,
                  },
                ]
              : []),
            ...(actions.copyText
              ? [
                  {
                    action: "copy-text",
                    icon: "copy" as const,
                    label: t.copyText.value,
                    run: actions.copyText,
                  },
                ]
              : []),
            {
              action: "copy-link",
              icon: "link",
              label: t.copyLink.value,
              run: actions.copyLink,
              testId: "read-select-link",
            },
          ]}
        />
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
      {lemma && (
        <p className="mt-0.5 text-sm" data-testid="read-select-lemma">
          <span className="opacity-75">{lemma.form}</span>
          <span aria-hidden className="mx-1 opacity-60">
            →
          </span>
          {lemma.href ? (
            <a
              href={lemma.href}
              className="font-medium underline decoration-[oklch(0.6_0.12_250/0.6)] underline-offset-2"
            >
              {lemma.lemma}
            </a>
          ) : (
            <span className="font-medium">{lemma.lemma}</span>
          )}
          {lemma.tags && <span className="ms-2 text-xs opacity-70">{lemma.tags}</span>}
        </p>
      )}
      {meaning && (
        <div className="mt-1 max-h-[30vh] overflow-y-auto text-sm">
          {/* Another language's entry, or one of several: say whose (lib/read/sense-pick.ts). */}
          {meaning.lang && (meaning.cross || !!meaning.others?.length) && (
            <p className="text-xs opacity-70" data-testid="read-select-entry-lang">
              {fill(t.entryIn.value, { lang: langLabel(meaning.lang, String(locale)) })}
              {mayPick && (
                <>
                  <span aria-hidden className="mx-1 opacity-60">
                    ·
                  </span>
                  {t.pickSense}
                </>
              )}
            </p>
          )}
          {(() => {
            const text = (
              // A span (block): it may sit inside the pick button.
              <span
                className="block whitespace-pre-line"
                data-testid="read-select-meaning"
                data-lang={meaning.lang}
              >
                {(meaning.other || (meaning.cross && meaning.term !== view.text?.trim())) && (
                  <span className="me-1.5 font-medium">{meaning.term}</span>
                )}
                {plainBack(meaning.back)}
                {meaning.own && <OwnKeyTag label={t.ownKey} />}
              </span>
            );
            // Another language's entry, not picked yet: tapping it says "this is the meaning
            // here" — kept, and the word is read in that language from then on.
            const choice = meaning.choice;
            return meaning.cross && !meaning.picked && choice && onPickSense ? (
              <button
                type="button"
                onClick={() => onPickSense(choice)}
                className="-mx-1 block min-h-11 w-[calc(100%+0.5rem)] rounded-lg px-1 py-1 text-start hover:bg-[oklch(0.5_0_0/0.08)] pointer-fine:min-h-0"
                data-testid="read-select-sense-main"
                data-lang={meaning.lang}
              >
                {text}
              </button>
            ) : (
              text
            );
          })()}
          {meaning.others?.map((o) => (
            <button
              key={o.choice}
              type="button"
              onClick={() => onPickSense?.(o.choice)}
              disabled={!onPickSense}
              className="-mx-1 mt-1 block min-h-11 w-[calc(100%+0.5rem)] rounded-lg px-1 py-1 text-start hover:bg-[oklch(0.5_0_0/0.08)] pointer-fine:min-h-0"
              data-testid="read-select-sense"
              data-lang={o.lang}
            >
              <span className="me-1.5 text-xs opacity-70">
                {fill(t.entryIn.value, { lang: langLabel(o.lang, String(locale)) })}
              </span>
              <span className="me-1.5 font-medium">{o.term}</span>
              <span className="whitespace-pre-line">{plainBack(o.back)}</span>
            </button>
          ))}
        </div>
      )}
      {translation && translation.blocks.some((b) => b.some((x) => x !== false)) && (
        <div
          className="mt-1 max-h-[40vh] space-y-1.5 overflow-y-auto text-sm"
          aria-live="polite"
          ref={transRef}
          onScroll={(e) => onMoreTranslation && nearEnd(e.currentTarget) && onMoreTranslation()}
          data-testid="read-select-translation"
          data-pending={translation.blocks.some((b) => b.includes(null)) || undefined}
        >
          {translation.blocks.every((b) => b.every((x) => x === null || x === false)) ? (
            <p className="opacity-60">{t.translating}</p>
          ) : (
            translation.blocks.map((b, i) => (
              <p key={i} className="whitespace-pre-line">
                {b.map((x, j) =>
                  x === false ? null : (
                    <span key={j} className={`me-1 ${x === null ? "opacity-60" : ""}`}>
                      {x ?? "…"}
                    </span>
                  ),
                )}
              </p>
            ))
          )}
          {translation.own && <OwnKeyTag label={t.ownKey} />}
        </div>
      )}

      {translateFailed && (
        <button
          type="button"
          onClick={translateFailed}
          className="-mx-1 mt-1 min-h-11 rounded-full px-1 text-start text-sm text-[oklch(0.52_0.17_30)] pointer-fine:min-h-0 dark:text-[oklch(0.76_0.14_30)]"
          data-testid="read-select-translate-retry"
        >
          {t.translateFailed}
          <span aria-hidden className="mx-1 opacity-60">
            ·
          </span>
          <span className="font-medium underline underline-offset-2">{t.retry}</span>
        </button>
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
            {u.kind === "range" ? t.reviewSelection : t.reviewWords}
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
        {actions.makePhrase && (
          <button
            type="button"
            className={btn}
            onClick={actions.makePhrase}
            data-action="make-phrase"
          >
            {t.makePhraseCard}
          </button>
        )}
        {actions.readFrom && (
          <button type="button" className={btn} onClick={actions.readFrom} data-action="read-from">
            {t.readFromHere}
          </button>
        )}
        {status && (
          <span role="status" className="px-2 text-xs opacity-75" data-testid="read-select-status">
            {status}
          </span>
        )}
      </div>
      {grade}
    </div>
  );
}
