import type { NextCard } from "./review-ui";

export type PreparedPreview = { url: string; previewUrl: string };

/** Retain the warmed frame when it becomes current; preload just one new successor. */
export function preparedPreviews(
  previous: readonly PreparedPreview[],
  currentUrl: string,
  next: NextCard | null | undefined,
): PreparedPreview[] {
  const current = previous.find((p) => p.url === currentUrl);
  const upcoming =
    next?.previewUrl && next.url !== currentUrl
      ? (previous.find((p) => p.url === next.url && p.previewUrl === next.previewUrl) ?? {
          url: next.url,
          previewUrl: next.previewUrl,
        })
      : undefined;
  return [...(current ? [current] : []), ...(upcoming ? [upcoming] : [])];
}
