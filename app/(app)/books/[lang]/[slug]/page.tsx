import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { bookKey, bookVisibleIn, catalogueBook } from "@/lib/books/catalogue";
import { normaliseSlug } from "@/lib/books/slug";
import { BookCard } from "../../BookCard";
import { booksAccess, languageName } from "../../access";

export const dynamic = "force-dynamic";

type Params = Promise<{ lang: string; slug: string }>;

/** The entry for a /books/<lang>/<slug> URL: the slug decoded and NFC-normalised. */
function entryOf(lang: string, slug: string) {
  const s = normaliseSlug(slug);
  if (!s || !/^[A-Za-z0-9-]{2,35}$/.test(lang)) return null;
  return catalogueBook(`${lang}/${s}`);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { lang, slug } = await params;
  const b = entryOf(lang, slug);
  return b ? { title: `${b.title} — ${b.author}` } : {};
}

/** One public-domain book's page: its stable URL (lib/books/slug.ts). */
export default async function BookPage({ params }: { params: Params }) {
  const { lang, slug } = await params;
  const b = entryOf(lang, slug);
  if (!b) notFound();
  const locale = await appLocale();
  const t = getIntlayer("books-page", locale);
  const { signedIn, owned, country, year } = await booksAccess();
  // Not public domain where the viewer is: as if it were not in the catalogue.
  if (!bookVisibleIn(b, country, year)) notFound();

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/books"
          className="text-sm text-[oklch(0.5_0_0)] dark:text-[oklch(0.7_0_0)] hover:underline"
        >
          &larr; {String(t.allBooks)}
        </Link>
        <p className="mt-4 text-sm font-semibold uppercase tracking-wide text-[oklch(0.5_0_0)] dark:text-[oklch(0.7_0_0)]">
          {languageName(b.lang, locale)}
        </p>
        <BookCard book={b} ownedId={owned[bookKey(b)]} signedIn={signedIn} detail />
      </div>
    </div>
  );
}
