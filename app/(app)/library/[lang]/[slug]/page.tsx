import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { bookVisibleIn } from "@/lib/books/catalogue";
import { booksAccess } from "../../access";
import { BookDetail, entryOf } from "../../BookDetail";

export const dynamic = "force-dynamic";

type Params = Promise<{ lang: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { lang, slug } = await params;
  const b = await entryOf(lang, slug);
  return b ? { title: `${b.title} — ${b.author}` } : {};
}

/** One catalogue book's page: its stable URL (lib/books/slug.ts). */
export default async function LibraryBookPage({ params }: { params: Params }) {
  const { lang, slug } = await params;
  const b = await entryOf(lang, slug);
  if (!b) notFound();
  const t = getIntlayer("books-page", await appLocale());
  const { signedIn, owned, country, year } = await booksAccess();
  // Not public domain where the viewer is: as if it were not in the catalogue.
  if (!bookVisibleIn(b, country, year)) notFound();
  return (
    <BookDetail
      book={b}
      owned={owned}
      signedIn={signedIn}
      back={{ href: "/library", label: String(t.allBooks) }}
    />
  );
}
