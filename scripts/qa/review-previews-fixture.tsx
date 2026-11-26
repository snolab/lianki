import React from "react";
import { createRoot } from "react-dom/client";
import { ReviewPagePreviews } from "../../app/(app)/review/ReviewPagePreviews";
import type { NextCard, ReviewCard } from "../../lib/review-ui";

const root = createRoot(document.getElementById("root")!);
const labels = {
  current: "Current page",
  next: "Up next",
  unavailable: "Preview unavailable. Open the page using its link.",
};
const render = (current: ReviewCard, next: NextCard | null, enabled = true) =>
  root.render(
    <ReviewPagePreviews current={current} next={next} enabled={enabled} labels={labels} />,
  );
(globalThis as unknown as { renderReviewPreviews: typeof render }).renderReviewPreviews = render;
