"use client";
import { publicCfg } from "@/lib/config-client";
import { reviewTitleScale } from "@/lib/review-title";

/**
 * The current card's title on /review, always shown in full (owner,
 * 2026-11-27): a long title gets a smaller font, down to
 * review.titleMinScalePct of the base size, then wraps; it is never clamped,
 * ellipsised or clipped. `overflow-wrap: anywhere` breaks a CJK title (no
 * spaces) or a long url anywhere. The wrapper sets the base size, so the scale
 * is plain `em` and the line height follows it.
 */
export function CardTitle({ text }: { text: string }) {
  const scale = reviewTitleScale(
    text,
    publicCfg("review.titleFitChars"),
    publicCfg("review.titleMinScalePct"),
  );
  return (
    <div className="text-2xl sm:text-3xl">
      <h2
        className="font-semibold leading-snug [overflow-wrap:anywhere]"
        style={{ fontSize: `${scale}em` }}
        data-testid="review-card-title"
        data-scale={scale}
      >
        {text}
      </h2>
    </div>
  );
}
