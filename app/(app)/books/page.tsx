import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { booksMineOn, libraryOn } from "@/lib/books/gate";
import {
  shelfBook,
  shelfByLang,
  shelfRows,
  type FileInfo,
  type ShelfBook,
  type ShelfRow,
} from "@/lib/books/shelf";
import { OWN_BOOK } from "@/lib/books/own-import";
import { getReadMaterialContent, type ReadMaterial } from "@/lib/getReadMaterialsCollection";
import { parseBookMeta } from "@/lib/read/book";
import { OwnBookImport } from "./OwnBookImport";
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
/** An own book's language, author and cover, from its meta (inline, or R2 for a big one). */
async function fileInfos(rows: ShelfRow[]): Promise<Map<string, FileInfo>> {
  const out = new Map<string, FileInfo>();
  await Promise.all(
    rows
      .filter((r) => r.source_key.startsWith("file:"))
      .map(async (r) => {
        try {
          const meta = parseBookMeta(
            await getReadMaterialContent({
              content: r.content ?? undefined,
              r2Key: r.r2_key ?? undefined,
            } as ReadMaterial),
          );
          if (meta)
            out.set(r.id, { lang: meta.lang, author: meta.author, cover: meta.cover === 1 });
        } catch (err) {
          console.error("books: own book meta failed", err);
        }
      }),
  );
  return out;
}

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
      const info = await fileInfos(rows);
      books = rows
        .map((r) =>
          shelfBook(
            r,
            (k) => byKey.get(k) ?? null,
            (id) => info.get(id),
          ),
        )
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
        <BooksShelf groups={groups} signedIn={!!user} library={library}>
          <OwnBookImport accept={OWN_BOOK.accept} maxBytes={OWN_BOOK.maxFileBytes} />
        </BooksShelf>
      </div>
    </div>
  );
}
