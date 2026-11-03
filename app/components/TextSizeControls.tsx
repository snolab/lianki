"use client";

import { useIntlayer } from "next-intlayer";
import {
  setTextSize,
  stepScale,
  TEXT_AREAS,
  TEXT_MAX,
  TEXT_MIN,
  textSizeStore,
  type TextArea,
} from "@/lib/text-size";
import { useTextSizes } from "@/lib/use-text-size";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Text size (lib/text-size.ts): per area, A− and A+ around the percentage.
 * A change shows at once (the CSS reads custom properties on <html>) and
 * follows the account (text-size.* in lib/prefs/schema.ts).
 *
 * `compact` is the /words settings sheet's: the three areas side by side
 * where they fit, a small heading, no note, so the sheet stays short.
 */
export function TextSizeControls({ compact = false }: { compact?: boolean }) {
  const text = useIntlayer("text-size");
  const sizes = useTextSizes();
  const label: Record<TextArea, string> = {
    ui: text.whole.value,
    chat: text.chat.value,
    cards: text.cards.value,
    read: text.read.value,
  };
  const changed = TEXT_AREAS.some((a) => sizes[a] !== 1);
  const btn =
    "grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[oklch(0.5_0_0/0.3)] font-medium leading-none hover:bg-[oklch(0.5_0_0/0.1)] disabled:opacity-30";
  const reset = changed && (
    <button
      type="button"
      className="min-h-10 shrink-0 rounded-lg px-2 underline-offset-2 opacity-80 hover:underline"
      onClick={() => textSizeStore.setState({ ui: 1, chat: 1, cards: 1, read: 1 })}
      data-text-size-reset
    >
      {text.reset}
    </button>
  );
  return (
    <div data-text-size className={compact ? "w-full pt-1" : ""}>
      {compact && (
        <div className="fs-11 font-medium uppercase tracking-wide opacity-50">{text.heading}</div>
      )}
      <div
        className={compact ? "flex flex-wrap items-center gap-x-4 gap-y-1" : "flex flex-col gap-1"}
        role="group"
        aria-label={text.heading.value}
      >
        {TEXT_AREAS.map((a) => (
          <div
            key={a}
            className={`flex items-center gap-1.5 ${compact ? "" : "w-full"}`}
            data-text-size-row={a}
          >
            <span className={`min-w-0 break-words ${compact ? "" : "flex-1"}`}>{label[a]}</span>
            <button
              type="button"
              className={`${btn} text-xs`}
              aria-label={`${label[a]}: ${text.smaller.value}`}
              title={text.smaller.value}
              disabled={sizes[a] <= TEXT_MIN}
              onClick={() => setTextSize(a, stepScale(sizes[a], -1))}
            >
              A−
            </button>
            <output className="w-[4.5ch] shrink-0 text-center tabular-nums" data-text-size-value>
              {pct(sizes[a])}
            </output>
            <button
              type="button"
              className={`${btn} text-lg`}
              aria-label={`${label[a]}: ${text.larger.value}`}
              title={text.larger.value}
              disabled={sizes[a] >= TEXT_MAX}
              onClick={() => setTextSize(a, stepScale(sizes[a], 1))}
            >
              A+
            </button>
          </div>
        ))}
        {compact && reset}
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <span className="min-w-0 flex-1 text-xs opacity-60">{text.hint}</span>
          <span className="text-sm">{reset}</span>
        </div>
      )}
    </div>
  );
}
