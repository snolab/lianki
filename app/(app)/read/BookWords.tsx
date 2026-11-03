"use client";

// A material's words on /read (lib/read/words.ts): the ring (coverage of
// known running words, pass mark 95%) with the pass tick and its date, the
// word counts, and in the reader's header the scan summary — mastered,
// learning, new, unrecognised — with a few unrecognised words shown and the
// rest a tap away. "New" includes words the language's dictionary has
// (lib/read/lemma.ts; the server marks them), not only our word lists.

import { useEffect, useMemo, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { ProgressRingSvg } from "@/app/components/progress-ring";
import { fill } from "@/lib/nav/nav-core";
import { longDate } from "@/lib/dates";
import { catalogKeys } from "@/lib/read/dict";
import { inKeys } from "@/lib/read/words";
import type { WordsSummary } from "@/lib/read/progress";

const nf = (locale: string) => new Intl.NumberFormat(locale);

/** The ring and, once passed, the ✓ with the day it first passed. */
export function BookRing({ words }: { words: WordsSummary }) {
  const text = useIntlayer("read-words");
  const { locale } = useLocale();
  if (words.coverage === null) return null;
  const pct = words.coverage;
  const label = fill(text.ringLabel.value, {
    pct,
    distinct: words.distinct,
    pass: words.passAt,
  });
  const shown = new Intl.NumberFormat(String(locale), { style: "percent" }).format(pct / 100);
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5">
      <span
        className="flex items-center gap-1.5 text-xs tabular-nums"
        title={label}
        aria-label={label}
        role="img"
        data-testid="read-ring"
        data-coverage={pct}
      >
        <ProgressRingSvg pct={pct} passAt={words.passAt} />
        <span className="min-w-[2.6em] text-end opacity-80">{shown}</span>
      </span>
      <PassTick words={words} />
    </span>
  );
}

function PassTick({ words }: { words: WordsSummary }) {
  const text = useIntlayer("read-words");
  const { locale } = useLocale();
  if (!words.passedAt) return null;
  const date = longDate(words.passedAt, String(locale));
  const now = words.passed;
  return (
    <span
      data-testid="read-passed"
      data-passed={now ? "1" : "0"}
      className={`whitespace-nowrap text-[11px] font-medium ${
        now
          ? "text-[oklch(0.5_0.14_155)] dark:text-[oklch(0.78_0.14_155)]"
          : "text-[oklch(0.5_0.03_155)] opacity-60 dark:text-[oklch(0.75_0.03_155)]"
      }`}
    >
      ✓ {fill(now ? text.passedOn.value : text.wasPassed.value, { date, pass: words.passAt })}
    </span>
  );
}

/** "4,916 words · 1,277 different" */
export function WordCountText({ words }: { words: WordsSummary }) {
  const text = useIntlayer("read-words");
  const { locale } = useLocale();
  const n = nf(String(locale));
  return (
    <>
      {fill(text.wordCount.value, {
        tokens: n.format(words.tokens),
        distinct: n.format(words.distinct),
      })}
    </>
  );
}

/** /api/read/[id]/words rows; the last two only for words without a card. */
type WordRow = [string, number, number, 0 | 1, 0 | 1, 0 | 1, (0 | 1)?, string[]?];

/** Unrecognised words shown inline before the full list is opened (most frequent first). */
const EXAMPLES = 6;
type Buckets = {
  mastered: number;
  learning: number;
  fresh: number;
  names: number;
  unrecognised: string[];
};

/**
 * The scan summary in the reader's header. Mastered and learning come from
 * the server (the reader's cards); new vs unrecognised needs the word lists,
 * which this device reads from its catalog cache, once per open.
 */
export function BookScan({ id, words }: { id: string; words: WordsSummary }) {
  const text = useIntlayer("read-words");
  const { locale } = useLocale();
  const n = nf(String(locale));
  const [rows, setRows] = useState<WordRow[] | null>(null);
  const [dict, setDict] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/read/${id}/words`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setRows(d.words as WordRow[]))
      .catch(() => {});
    catalogKeys(words.lang)
      .then((k) => live && setDict(k))
      .catch(() => live && setDict(new Set()));
    return () => {
      live = false;
    };
  }, [id, words.lang]);

  const b = useMemo<Buckets | null>(() => {
    if (!rows || !dict) return null;
    const out: Buckets = { mastered: 0, learning: 0, fresh: 0, names: 0, unrecognised: [] };
    for (const [w, , score, mastered, ownDeck, name, inDictionary, heads] of rows) {
      if (score >= 0) {
        if (mastered) out.mastered++;
        else out.learning++;
      } else if (
        ownDeck ||
        inDictionary ||
        inKeys(w, words.lang, dict) ||
        heads?.some((h) => dict.has(h))
      )
        out.fresh++;
      else if (name) out.names++;
      else out.unrecognised.push(w);
    }
    return out;
  }, [rows, dict, words.lang]);

  const total = words.distinct || 1;
  const seg = (count: number, cls: string, key: string) =>
    count > 0 ? (
      <span key={key} className={cls} style={{ width: `${(count / total) * 100}%` }} />
    ) : null;

  return (
    <section
      data-testid="read-scan"
      className="rounded-lg border border-[oklch(0.5_0_0/0.15)] p-3 text-sm"
      aria-label={fill(text.scanTitle.value, { distinct: n.format(words.distinct) })}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">
            {fill(text.scanTitle.value, { distinct: n.format(words.distinct) })}
          </h2>
          <p className="text-xs opacity-70 tabular-nums">
            <WordCountText words={words} />
          </p>
        </div>
        <BookRing words={words} />
      </div>

      {!b ? (
        <p className="mt-2 text-xs opacity-60">{text.checking}</p>
      ) : (
        <>
          <div
            className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-[oklch(0.5_0_0/0.12)] dark:bg-[oklch(0.8_0_0/0.12)]"
            aria-hidden
          >
            {seg(b.mastered, "bg-[oklch(0.58_0.14_155)] dark:bg-[oklch(0.76_0.14_155)]", "m")}
            {seg(
              b.learning,
              "bg-[oklch(0.58_0.14_155/0.45)] dark:bg-[oklch(0.76_0.14_155/0.45)]",
              "l",
            )}
            {seg(
              b.fresh,
              "bg-[oklch(0.62_0.12_250/0.55)] dark:bg-[oklch(0.72_0.12_250/0.55)]",
              "n",
            )}
            {seg(
              b.names + b.unrecognised.length,
              "bg-[oklch(0.7_0.12_70/0.55)] dark:bg-[oklch(0.75_0.12_70/0.5)]",
              "u",
            )}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums sm:grid-cols-4">
            <Stat label={text.mastered.value} value={n.format(b.mastered)} testid="mastered" />
            <Stat label={text.learning.value} value={n.format(b.learning)} testid="learning" />
            <Stat label={text.newWords.value} value={n.format(b.fresh)} testid="new" />
            <Stat
              label={text.unrecognised.value}
              value={n.format(b.unrecognised.length)}
              testid="unrecognised"
            />
          </dl>
          {b.names > 0 && (
            <p className="mt-1 text-xs opacity-60 tabular-nums" data-testid="read-scan-names">
              {text.names}: {n.format(b.names)}
            </p>
          )}
          <p className="mt-2 text-xs opacity-60">{text.legend}</p>
          {b.unrecognised.length > 0 && (
            <div className="mt-2">
              {!open && (
                <ul
                  data-testid="read-scan-examples"
                  className="flex flex-wrap items-center gap-1.5 text-xs"
                >
                  {b.unrecognised.slice(0, EXAMPLES).map((w) => (
                    <li
                      key={w}
                      className="rounded bg-[oklch(0.5_0_0/0.08)] px-1.5 py-0.5 dark:bg-[oklch(0.8_0_0/0.1)]"
                    >
                      {w}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="min-h-[44px] text-xs font-medium text-[oklch(0.5_0.14_250)] underline-offset-2 hover:underline dark:text-[oklch(0.75_0.12_250)]"
                aria-expanded={open}
                data-testid="read-scan-toggle"
                onClick={() => setOpen((o) => !o)}
              >
                {open ? text.hideUnrecognised : text.showUnrecognised}
              </button>
              {open && (
                <ul
                  data-testid="read-scan-unrecognised"
                  className="mt-1 flex max-h-60 flex-wrap gap-1.5 overflow-y-auto text-xs"
                >
                  {b.unrecognised.slice(0, 3000).map((w) => (
                    <li
                      key={w}
                      className="rounded bg-[oklch(0.5_0_0/0.08)] px-1.5 py-0.5 dark:bg-[oklch(0.8_0_0/0.1)]"
                    >
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="mt-2 text-[11px] opacity-50">{text.approx}</p>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="opacity-70">{label}</dt>
      <dd data-testid={`read-scan-${testid}`} className="font-medium">
        {value}
      </dd>
    </div>
  );
}
