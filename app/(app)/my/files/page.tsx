import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { importAnyOn } from "@/lib/import/words-handler";
import { booksMineOn } from "@/lib/books/gate";
import MyFilesClient from "./MyFilesClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { cards } = getIntlayer("my-page", await appLocale());
  return { title: `${cards.files.title} - Lianki`, robots: { index: false, follow: false } };
}

/**
 * /my/files: every file the user stored, in folders by origin (inbox_item
 * `source`; docs/import-material.md, "My Files"). Signed-in only, never
 * owner-only: the listing comes from GET /api/my/files, behind the file
 * store's gate (`import.any`); without it the page shows the empty state.
 */
export default async function MyFilesPage() {
  const user = await authUserOrNull();
  if (!user) return signInRedirect();
  const { files } = getIntlayer("my-page", await appLocale());
  // Without the store's gate there is nothing to list: no request, the empty state.
  const flags = user.email ? await readFlags() : null;
  const on =
    !!user.email &&
    (importAnyOn(flags, isDev(user.email)) || booksMineOn(flags, isDev(user.email)));
  return <MyFilesClient back={String(files.back)} on={on} />;
}
