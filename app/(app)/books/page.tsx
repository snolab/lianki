import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { catalogueByLang, catalogueFor } from "@/lib/books/catalogue";
import { BooksBrowser } from "./BooksBrowser";
import { BookFinder } from "./BookFinder";
import { allBooks, booksAccess, languageName } from "./access";

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
        <BooksBrowser
          groups={catalogueByLang(catalogueFor(country, year, await allBooks())).map(
            ([lang, books]) => [lang, languageName(lang, locale), books],
          )}
          owned={owned}
          signedIn={signedIn}
        />
        {signedIn && <BookFinder />}
      </div>
    </div>
  );
}
