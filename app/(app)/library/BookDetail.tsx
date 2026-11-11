import Link from "next/link";
import { appLocale } from "@/lib/app-locale.server";
import { bookKey, type CatalogueBook } from "@/lib/books/catalogue";
import { normaliseSlug } from "@/lib/books/slug";
import { BookCard } from "./BookCard";
import { findBook, languageName } from "./access";

/** The entry for a <lang>/<slug> URL: the slug decoded and NFC-normalised; null when none. */
export async function entryOf(lang: string, slug: string): Promise<CatalogueBook | null> {
  const s = normaliseSlug(slug);
  if (!s || !/^[A-Za-z0-9-]{2,35}$/.test(lang)) return null;
  return findBook(lang, s);
}

/**
 * One catalogue book: its card with the attribution, and a back link. Shared
 * by /library/<lang>/<slug> and, for a book on the viewer's shelf, the old
 * /books/<lang>/<slug> (back to My books there).
 */
export async function BookDetail({
  book,
  owned,
  signedIn,
  back,
}: {
  book: CatalogueBook;
  owned: Record<string, string>;
  signedIn: boolean;
  back: { href: string; label: string };
}) {
  const locale = await appLocale();
  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="max-w-3xl mx-auto">
        <Link href={back.href} className="text-sm text-gray-500 dark:text-gray-400 hover:underline">
          &larr; {back.label}
        </Link>
        <p className="mt-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {languageName(book.lang, locale)}
        </p>
        <BookCard book={book} ownedId={owned[bookKey(book)]} signedIn={signedIn} detail />
      </div>
    </div>
  );
}
