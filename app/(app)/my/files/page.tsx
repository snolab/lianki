import type { Metadata } from "next";
import Link from "next/link";
import { getIntlayer } from "intlayer";
import { Icon } from "@/app/components/icons";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { cards } = getIntlayer("my-page", await appLocale());
  return { title: `${cards.files.title} - Lianki`, robots: { index: false, follow: false } };
}

/**
 * /my/files: the user's uploaded files, in folders by origin (inbox_item
 * `source`; docs/import-material.md). Reserved by the /my move (2026-11-10):
 * only the empty state for now — the file store fills in the listing.
 */
export default async function MyFilesPage() {
  if (!(await authUserOrNull())) return signInRedirect();
  const { cards, files } = getIntlayer("my-page", await appLocale());
  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <Link
        href="/my"
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 mb-4"
      >
        <Icon name="folder" />
        {files.back}
      </Link>
      <h1 className="text-3xl font-bold mb-6 flex items-center gap-2">
        <Icon name="folderSimple" />
        {cards.files.title}
      </h1>
      <p
        data-testid="my-files-empty"
        className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-8 text-center text-gray-600 dark:text-gray-400"
      >
        {files.empty}
      </p>
    </main>
  );
}
