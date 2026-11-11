// The /library gate and the viewer's own copies, shared by the /library pages (and /books).

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { libraryOn } from "@/lib/books/gate";
import { ownedPresets } from "@/lib/books/owned";
import { ruleYear, viewerCountry } from "@/lib/books/viewer";
import { LANG_TAGS } from "@/lib/constants";
import { CATALOGUE, catalogueBook, type CatalogueBook } from "@/lib/books/catalogue";
import { d1SharedStore, mergeCatalogue } from "@/lib/books/shared";

/**
 * The viewer, the books they already added, and where and when they are (the
 * admission rule's country and year: lib/books/terms.ts); 404 while /books is
 * off for them (`library.catalogue`).
 */
export async function booksAccess(): Promise<{
  signedIn: boolean;
  owned: Record<string, string>;
  country: string | null;
  year: number;
}> {
  const user = await authUserOrNull();
  if (dbBackend() !== "d1") notFound();
  if (!libraryOn(await readFlags(), isDev(user?.email ?? null))) notFound();
  let owned: Record<string, string> = {};
  if (user) {
    try {
      owned = await ownedPresets(user.id);
    } catch (err) {
      console.error("books: owned list failed", err);
    }
  }
  return { signedIn: !!user, owned, country: viewerCountry(await headers()), year: ruleYear() };
}

/** The whole catalogue: the curated entries, then the shared ones (D1); shared skipped on error. */
export async function allBooks(): Promise<CatalogueBook[]> {
  try {
    return mergeCatalogue(await d1SharedStore().list());
  } catch (err) {
    console.error("books: shared list failed", err);
    return CATALOGUE;
  }
}

/** The entry for "<lang>/<slug>": curated, else shared. */
export async function findBook(lang: string, slug: string): Promise<CatalogueBook | null> {
  const curated = catalogueBook(`${lang}/${slug}`);
  if (curated) return curated;
  try {
    return await d1SharedStore().byKey(lang, slug);
  } catch (err) {
    console.error("books: shared lookup failed", err);
    return null;
  }
}

/** A language's name in the UI locale (Intl.DisplayNames), else its code. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([LANG_TAGS[locale] ?? locale], { type: "language" }).of(
      code,
    );
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : code;
  } catch {
    return code;
  }
}
