"use client";

import { useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { CatalogueBook } from "@/lib/books/catalogue";
import { BookCard } from "./BookCard";

/**
 * The /books list with an instant filter (title, author, language, level):
 * the catalogue is small and already on the page, so filtering is local —
 * no request, no AI. Groups by language as the server ordered them.
 */
export function BooksBrowser({
  groups,
  owned,
  signedIn,
}: {
  /** [language code, its display name, its books] in page order. */
  groups: [string, string, CatalogueBook[]][];
  owned: Record<string, string>;
  signedIn: boolean;
}) {
  const t = useIntlayer("books-page");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return groups;
    return groups
      .map(([lang, name, books]) => {
        const match = books.filter((b) => {
          const hay = [b.title, b.author, b.lang, name, b.level, String(b.firstPublicationYear)]
            .join(" ")
            .normalize("NFC")
            .toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        return [lang, name, match] as [string, string, CatalogueBook[]];
      })
      .filter(([, , books]) => books.length);
  }, [groups, q]);

  return (
    <>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t.filter.value}
        aria-label={t.filter.value}
        data-testid="books-filter"
        className="w-full mb-8 rounded-lg border border-gray-300 dark:border-gray-600 bg-white/60 dark:bg-gray-900/60 px-4 py-2 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      />
      {shown.length === 0 && <p className="mb-8 text-gray-500 dark:text-gray-400">{t.noMatch}</p>}
      {shown.map(([lang, name, books]) => (
        <section key={lang} className="mb-10" data-testid="books-lang" data-lang={lang}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
            {name}
          </h2>
          {books.map((b) => (
            <BookCard
              key={b.slug}
              book={b}
              ownedId={owned[`${b.lang}/${b.slug}`]}
              signedIn={signedIn}
            />
          ))}
        </section>
      ))}
    </>
  );
}
