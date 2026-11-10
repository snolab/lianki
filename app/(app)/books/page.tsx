import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { booksMineOn, libraryOn } from "@/lib/books/gate";
import { shelfBook, shelfByLang, shelfRows, type ShelfBook } from "@/lib/books/shelf";
import { allBooks, languageName } from "../library/access";
import { BooksShelf } from "./BooksShelf";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("my-books", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

/**
 * /books: My books, the user's own shelf (docs/books-plan.md, "/library and
 * /books"): the books they added from /library and the book files they
 * imported, grouped by language (their preferred languages first), each
 * opening in the reader. The catalogue itself is /library. Off
 * (`books.mine`): a temporary redirect to /library.
 */
export default async function MyBooksPage() {
  const user = await authUserOrNull();
  const locale = await appLocale();
  const t = getIntlayer("my-books", locale);
  const flags = dbBackend() === "d1" ? await readFlags() : null;
  const dev = isDev(user?.email ?? null);
  if (!flags || !booksMineOn(flags, dev)) redirect("/library");
  const library = libraryOn(flags, dev);

  let books: ShelfBook[] = [];
  if (user) {
    try {
      const [rows, catalogue] = await Promise.all([shelfRows(getD1(), user.id), allBooks()]);
      const byKey = new Map(catalogue.map((b) => [`${b.lang}/${b.slug}`, b]));
      books = rows
        .map((r) => shelfBook(r, (k) => byKey.get(k) ?? null))
        .filter((b): b is ShelfBook => !!b);
    } catch (err) {
      console.error("books: shelf failed", err);
    }
  }
  const groups = shelfByLang(books).map(
    ([lang, list]) =>
      [lang, lang ? languageName(lang, locale) : "", list] as [string, string, ShelfBook[]],
  );

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-3">{String(t.title)}</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">{String(t.intro)}</p>
        <BooksShelf groups={groups} signedIn={!!user} library={library} />
      </div>
    </div>
  );
}
