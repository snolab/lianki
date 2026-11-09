import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
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
  if (!(await authUserOrNull())) return signInRedirect();
  const { files } = getIntlayer("my-page", await appLocale());
  return <MyFilesClient back={String(files.back)} />;
}
