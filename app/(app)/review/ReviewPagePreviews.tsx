"use client";

import { useEffect, useState } from "react";
import type { NextCard, ReviewCard } from "@/lib/review-ui";
import { reviewTitle } from "@/lib/review-title";
import { preparedPreviews, type PreparedPreview } from "@/lib/review-preview-state";

export function ReviewPagePreviews({
  current,
  next,
  enabled,
  labels,
}: {
  current: ReviewCard;
  next: NextCard | null | undefined;
  enabled: boolean;
  labels: { current: string; next: string; unavailable: string };
}) {
  const [prepared, setPrepared] = useState<PreparedPreview[]>([]);
  useEffect(() => {
    setPrepared((old) => (enabled ? preparedPreviews(old, current.url, next) : []));
  }, [current.url, next?.url, next?.previewUrl, enabled]);
  if (!enabled) return null;

  const pages = prepared.filter((p) => p.url === current.url || p.url === next?.url);
  const fallback = next && !pages.some((p) => p.url === next.url) ? next : null;
  return (
    <div className="space-y-3" data-testid="review-page-previews">
      {pages.map((page) => {
        const isCurrent = page.url === current.url;
        const card = isCurrent ? current : next!;
        const title = reviewTitle(card.title, card.url) ?? card.url;
        return (
          <section
            key={page.url}
            className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10"
            data-preview-url={page.url}
          >
            <div className="flex min-w-0 gap-2 bg-white/60 dark:bg-gray-900/60 px-3 py-2 text-sm">
              <span className="shrink-0 font-semibold">
                {isCurrent ? labels.current : labels.next}
              </span>
              <a
                className="min-w-0 truncate underline"
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                dir="auto"
              >
                {title}
              </a>
            </div>
            <iframe
              src={page.previewUrl}
              title={title}
              sandbox=""
              allow="autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; fullscreen 'none'"
              referrerPolicy="no-referrer"
              loading="eager"
              className="h-48 w-full border-0 bg-white sm:h-64"
            />
          </section>
        );
      })}
      {fallback && (
        <section
          className="rounded-xl border border-black/10 dark:border-white/10 px-3 py-2 text-sm"
          data-testid="review-preview-fallback"
        >
          <span className="font-semibold">{labels.next} </span>
          <a
            className="underline break-words"
            href={fallback.url}
            target="_blank"
            rel="noopener noreferrer"
            dir="auto"
          >
            {reviewTitle(fallback.title, fallback.url) ?? fallback.url}
          </a>
          <p className="mt-1 opacity-70">{labels.unavailable}</p>
        </section>
      )}
    </div>
  );
}
