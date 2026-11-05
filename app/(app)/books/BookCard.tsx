"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import type { CatalogueBook } from "@/lib/books/catalogue";
import { bookHref } from "@/lib/books/slug";

/**
 * One public-domain book on /books: title, author, level, source link and
 * licence always visible; one tap adds it to My reading (/read) and opens it,
 * or opens the copy the user already has.
 */
export function BookCard({
  book,
  ownedId,
  signedIn,
  detail = false,
}: {
  book: CatalogueBook;
  /** The user's own copy in /read, when they already added it. */
  ownedId?: string;
  signedIn: boolean;
  /** On the book's own page: the title is not a link, the attribution shows. */
  detail?: boolean;
}) {
  const t = useIntlayer("books-page");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/books/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book: `${book.lang}/${book.slug}` }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!res.ok || !data?.id) {
        setError(
          data?.error === "rate-limited"
            ? t.errRateLimited.value
            : data?.error === "not-public-domain-here"
              ? t.errNotHere.value
              : t.errFailed.value,
        );
        return;
      }
      router.push(`/read/${encodeURIComponent(data.id)}`);
    } catch {
      setError(t.errFailed.value);
    } finally {
      setBusy(false);
    }
  };

  const button =
    "shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60";
  // The 書法 theme's tokens (app/globals.css: "blue" is the seal red, "gray" the
  // paper→ink ramp). One primary per view: the add button on a book's own
  // page; on the list every card's actions are secondary.
  const primary = `${button} bg-blue-600 text-white hover:bg-blue-700`;
  const secondary = `${button} border border-blue-600/40 text-blue-700 dark:text-blue-300 hover:bg-blue-600/10`;
  const quiet = `${button} text-blue-700 dark:text-blue-300 hover:bg-blue-600/10`;

  return (
    <article
      data-testid="books-card"
      data-book={`${book.lang}/${book.slug}`}
      className="flex flex-col gap-2 py-4 border-b border-gray-200 dark:border-gray-700 last:border-b-0"
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="flex-1 min-w-0" lang={book.lang}>
          {detail ? (
            <h1 className="text-2xl font-bold">{book.title}</h1>
          ) : (
            <h3 className="font-semibold text-lg leading-snug">
              <Link href={bookHref(book)} className="hover:underline">
                {book.title}
              </Link>
            </h3>
          )}
          <p className="text-sm text-gray-600 dark:text-gray-400">{book.author}</p>
        </div>
        {ownedId ? (
          <Link
            href={`/read/${encodeURIComponent(ownedId)}`}
            data-testid="books-owned"
            className={detail ? primary : quiet}
          >
            {t.owned}
          </Link>
        ) : signedIn ? (
          <button
            type="button"
            data-testid="books-add"
            disabled={busy}
            onClick={() => void add()}
            className={detail ? primary : secondary}
          >
            {busy ? t.adding : t.add}
          </button>
        ) : (
          <a
            href={`/sign-in?to=${encodeURIComponent(bookHref(book))}`}
            className={detail ? primary : quiet}
          >
            {t.signIn}
          </a>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        {book.level && (
          <span className="rounded-full bg-blue-600/10 px-2 py-0.5 font-medium text-blue-700 dark:text-blue-300">
            {t.level} {book.level}
          </span>
        )}
        {book.form && <span>{book.form === "verse" ? t.verse : t.prose}</span>}
        <span>{book.firstPublicationYear}</span>
        <span>
          {t.source}:{" "}
          <a
            href={book.source.page}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="books-source"
            className="underline hover:text-blue-700 dark:hover:text-blue-300"
          >
            {book.source.name}
          </a>
        </span>
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t.licence}: {book.licence}
      </p>
      {detail && <p className="text-xs text-gray-500 dark:text-gray-400">{book.attribution}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </article>
  );
}
