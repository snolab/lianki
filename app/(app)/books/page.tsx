import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { CATALOGUE, bookKey, catalogueByLang } from "@/lib/books/catalogue";
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
 * own books: those are /read, where a book added here then lives.
 */
export default async function BooksPage() {
  const locale = await appLocale();
  const t = getIntlayer("books-page", locale);
  const { signedIn, owned } = await booksAccess();

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-3">{String(t.title)}</h1>
        <p className="text-[oklch(0.45_0_0)] dark:text-[oklch(0.75_0_0)] mb-8">{String(t.intro)}</p>
        {catalogueByLang(CATALOGUE).map(([lang, books]) => (
          <section key={lang} className="mb-10" data-testid="books-lang" data-lang={lang}>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[oklch(0.5_0_0)] dark:text-[oklch(0.7_0_0)] mb-1">
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
