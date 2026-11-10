"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import type { ShelfBook } from "@/lib/books/shelf";
import { orderByPreferred } from "@/lib/lang-order";
import { usePreferredLangs } from "@/lib/use-preferred-langs";

/**
 * The shelf on /books: the user's books grouped by language, their preferred
 * languages first (lib/lang-order.ts), then the rest as the server ordered
 * them (newest first). Each book opens in the reader. `children` (the import
 * box) comes above the list.
 */
export function BooksShelf({
  groups,
  signedIn,
  library,
  children,
}: {
  /** [language code ("" unknown), its display name, its books] in server order. */
  groups: [string, string, ShelfBook[]][];
  signedIn: boolean;
  /** /library is open to this viewer: link to it. */
  library: boolean;
  children?: ReactNode;
}) {
  const t = useIntlayer("my-books");
  // Server order until mount, so hydration agrees; then preferred languages first.
  const { langs: preferred } = usePreferredLangs();
  const ordered = useMemo(
    () => orderByPreferred(groups, (g) => g[0], preferred),
    [groups, preferred],
  );
  const link =
    "inline-flex items-center gap-1 text-sm font-medium text-blue-700 dark:text-blue-300 hover:underline";

  if (!signedIn)
    return (
      <div className="flex flex-col items-start gap-3" data-testid="my-books-guest">
        <a
          href={`/sign-in?to=${encodeURIComponent("/books")}`}
          className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {t.signIn}
        </a>
        {library && (
          <Link href="/library" className={link}>
            {t.browse} &rarr;
          </Link>
        )}
      </div>
    );

  const total = groups.reduce((n, g) => n + g[2].length, 0);
  return (
    <div data-testid="my-books">
      {library && (
        <Link href="/library" className={`${link} mb-6`} data-testid="my-books-browse">
          {t.browse} &rarr;
        </Link>
      )}
      {children}
      {total === 0 && (
        <p className="mt-6 text-gray-600 dark:text-gray-400" data-testid="my-books-empty">
          {t.empty}
        </p>
      )}
      {ordered.map(([lang, name, books]) => (
        <section key={lang || "-"} className="mt-8" data-testid="my-books-lang" data-lang={lang}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
            {name || t.otherLanguage}
          </h2>
          {books.map((b) => (
            <article
              key={b.id}
              data-testid="my-books-book"
              data-origin={b.origin}
              className="flex items-start gap-3 py-4 border-b border-gray-200 dark:border-gray-700 last:border-b-0"
            >
              {b.cover && (
                // The user's own cover, served to them only; decorative beside the title.
                <img
                  src={`/api/books/mine/${encodeURIComponent(b.id)}/cover`}
                  alt=""
                  loading="lazy"
                  data-testid="my-books-cover"
                  className="h-20 w-14 shrink-0 rounded object-cover border border-gray-200 dark:border-gray-700"
                />
              )}
              <div className="flex-1 min-w-0" lang={b.lang || undefined}>
                <h3 className="font-semibold text-lg leading-snug">
                  <Link href={`/reader/${encodeURIComponent(b.id)}`} className="hover:underline">
                    {b.title}
                  </Link>
                </h3>
                {b.author && <p className="text-sm text-gray-600 dark:text-gray-400">{b.author}</p>}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {b.origin === "library" ? t.fromLibrary : t.imported}
                </p>
              </div>
              <Link
                href={`/reader/${encodeURIComponent(b.id)}`}
                className="shrink-0 rounded-full px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-600/10"
              >
                {t.open}
              </Link>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
