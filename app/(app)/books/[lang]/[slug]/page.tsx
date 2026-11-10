import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { booksMineOn } from "@/lib/books/gate";
import { ownedPresets } from "@/lib/books/owned";
import { legacyBookTarget } from "@/lib/books/legacy-link";
import { BookDetail, entryOf } from "../../../library/BookDetail";

export const dynamic = "force-dynamic";

type Params = Promise<{ lang: string; slug: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { lang, slug } = await params;
  const b = await entryOf(lang, slug);
  return b ? { title: `${b.title} — ${b.author}`, robots: { index: false, follow: true } } : {};
}

/** The query string of the request, rebuilt from the page's search params. */
function queryOf(sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp))
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  return q.toString();
}

/**
 * The old catalogue link /books/<lang>/<slug> (lib/books/legacy-link.ts): a
 * book on the viewer's shelf stays here as their own book (back to My books);
 * any other viewer gets a 308 to /library/<lang>/<slug>, query kept. Dynamic,
 * so the viewer-dependent redirect is never cached.
 */
export default async function OldBookLink({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { lang, slug } = await params;
  const user = await authUserOrNull();
  let owned: Record<string, string> = {};
  let shelf = false;
  if (user && dbBackend() === "d1") {
    shelf = booksMineOn(await readFlags(), isDev(user.email ?? null));
    if (shelf) {
      try {
        owned = await ownedPresets(user.id);
      } catch (err) {
        console.error("books: owned list failed", err);
      }
    }
  }
  const target = legacyBookTarget({
    lang,
    slug,
    search: queryOf(await searchParams),
    owned,
    shelf,
  });
  if (!target.stay) permanentRedirect(target.href);

  const b = await entryOf(lang, slug);
  if (!b) notFound();
  const t = getIntlayer("my-books", await appLocale());
  return (
    <BookDetail book={b} owned={owned} signedIn back={{ href: "/books", label: String(t.title) }} />
  );
}
