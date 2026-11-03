"use client";

/**
 * A word's stamps, in its sheet (WordsClient.tsx SlipSheet): one seal per
 * grade that stands, oldest first, in the grade's ink (Again red, Hard amber,
 * Good green, Easy blue: the slips' own --ink-*), carved with the grade's key
 * 1–4 so colour is never the only cue. Tap one for its grade and date.
 * Fetched once when the sheet opens; nothing polls.
 */
import "./stats.css";
import { useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { fill } from "@/lib/nav/nav-core";
import { longDateTime } from "@/lib/dates";

const GRADE_CLASS = ["", "grade-again", "grade-hard", "grade-good", "grade-easy"];

export default function WordStamps({ listId, term }: { listId: string; term: string }) {
  const text = useIntlayer("words-stats");
  const grades = useIntlayer("words-page");
  const { locale } = useLocale();
  const [reviews, setReviews] = useState<[number, string][] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetch(
      `/api/words/lists/${encodeURIComponent(listId)}/history?term=${encodeURIComponent(term)}`,
      {
        credentials: "same-origin",
      },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { reviews?: [number, string][] } | null) => live && setReviews(d?.reviews ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [listId, term]);

  // Offline or failed: the sheet simply has no stamp row.
  if (!reviews) return null;
  const name = (r: number) =>
    ["", grades.again.value, grades.hard.value, grades.good.value, grades.easy.value][r] ?? "";
  const shown = picked !== null ? reviews[picked] : null;
  return (
    <div className="border-b border-black/10 dark:border-white/10 px-1 py-3" data-sheet-stamps>
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="font-medium opacity-70">{text.stampsHeading}</span>
        {reviews.length > 0 && <span className="opacity-50 tabular-nums">{reviews.length}</span>}
        <span className="ms-auto truncate opacity-70" aria-live="polite">
          {shown &&
            fill(text.stampCaption.value, {
              grade: name(shown[0]),
              date: longDateTime(shown[1], locale),
            })}
        </span>
      </div>
      {reviews.length === 0 ? (
        <p className="text-xs opacity-50">{text.stampsNone}</p>
      ) : (
        <div className="lk-stamp-row max-h-32 overflow-y-auto overscroll-contain">
          {reviews.map(([r, at], i) => (
            <button
              key={`${i}-${at}`}
              type="button"
              aria-pressed={picked === i}
              aria-label={fill(text.stampCaption.value, {
                grade: name(r),
                date: longDateTime(at, locale),
              })}
              onClick={() => setPicked(picked === i ? null : i)}
              className={`lk-grade-seal ${GRADE_CLASS[r] ?? ""}`}
              style={{ transform: `rotate(${((i * 7) % 9) - 4}deg)` }}
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
