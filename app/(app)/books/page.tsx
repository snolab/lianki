import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { bookKey, catalogueByLang, catalogueFor } from "@/lib/books/catalogue";
import { BookCard } from "./BookCard";
import { booksAccess, languageName } from "./access";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("books-page", await appLocale());
  return { title: String(title) };
}

/**
 * /books: the shared public-domain library (docs/books-plan.md, "The
 * catalogue: /books"), grouped by language, easiest first. Never the user's
 * own books: those are /read, where a book added here then lives. Only the
 * books public domain where the viewer is (lib/books/terms.ts).
 */
export default async function BooksPage() {
  const locale = await appLocale();
  const t = getIntlayer("books-page", locale);
  const { signedIn, owned, country, year } = await booksAccess();

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-3">{String(t.title)}</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-8">{String(t.intro)}</p>
        {catalogueByLang(catalogueFor(country, year)).map(([lang, books]) => (
          <section key={lang} className="mb-10" data-testid="books-lang" data-lang={lang}>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              {languageName(lang, locale)}
            </h2>
            {books.map((b) => (
              <BookCard key={b.slug} book={b} ownedId={owned[bookKey(b)]} signedIn={signedIn} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
