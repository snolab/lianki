"use client";

import { renderFurigana } from "@/app/lib/furigana";

type FuriganaTextProps = {
  sentence: string;
  reading?: string;
  className?: string;
  highlightWord?: string;
};

export function FuriganaText({ sentence, reading, className, highlightWord }: FuriganaTextProps) {
  let html = renderFurigana(sentence, reading);

  if (highlightWord) {
    const escaped = highlightWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(
      new RegExp(`(${escaped})`, "g"),
      '<mark class="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">$1</mark>',
    );
  }

  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
