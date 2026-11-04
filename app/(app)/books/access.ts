// The /books gate and the viewer's own copies, shared by both /books pages.

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { booksOn } from "@/lib/books/gate";
import { ownedPresets } from "@/lib/books/owned";
import { ruleYear, viewerCountry } from "@/lib/books/viewer";
import { LANG_TAGS } from "@/lib/constants";

/**
 * The viewer, the books they already added, and where and when they are (the
 * admission rule's country and year: lib/books/terms.ts); 404 while /books is
 * off for them.
 */
export async function booksAccess(): Promise<{
  signedIn: boolean;
  owned: Record<string, string>;
  country: string | null;
  year: number;
}> {
  const user = await authUserOrNull();
  if (dbBackend() !== "d1") notFound();
  if (!booksOn(await readFlags(), isOwner(user?.email ?? null))) notFound();
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
