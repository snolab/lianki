"use client";

import { useIntlayer } from "next-intlayer";
import type { BookMeta } from "@/lib/read/book";

/**
 * A book added from /books: where its text comes from (a link to the source
 * page) and its licence, at the top of the book in either reader. Nothing for
 * the user's own uploads.
 */
export function BookSourceNote({
  book,
  className = "",
}: {
  book?: BookMeta | null;
  className?: string;
}) {
  const t = useIntlayer("books-page");
  if (book?.source !== "preset" || !book.credit || !book.sourceUrl) return null;
  return (
    <div
      data-testid="read-book-source"
      className={`text-xs leading-relaxed text-[oklch(0.5_0_0)] dark:text-[oklch(0.72_0_0)] ${className}`}
    >
      <p>
        {t.source}:{" "}
        <a
          href={book.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-[oklch(0.5_0.176_22.3)]"
        >
          {book.credit.sourceName}
        </a>
        {" · "}
        {t.licence}: {book.credit.licence}
      </p>
      <p>{book.credit.attribution}</p>
    </div>
  );
}
