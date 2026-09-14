import type { Metadata } from "next";
import Link from "next/link";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appHref } from "@/lib/app-locale";
import { appLocale } from "@/lib/app-locale.server";
import { IMMERSION_DOMAINS, IMMERSION_LANGUAGES } from "@/lib/immersion-sites";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("lab-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/lab"),
  };
}

export default async function LabPage() {
  const locale = await appLocale();
  const { heading, intro, experiments } = getIntlayer("lab-page", locale);

  // One entry per experiment; the list is the page, so it lives here rather
  // than in a registry nothing else reads.
  const cards = [
    {
      href: "/lab/immersion",
      icon: "🗺",
      title: experiments.immersion.title,
      blurb: experiments.immersion.blurb,
      stat: `${IMMERSION_DOMAINS.length} topics × ${IMMERSION_LANGUAGES.length} languages`,
    },
  ];

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">🧪 {heading}</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">{intro}</p>

      <ul className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <li key={card.href}>
            <Link
              href={appHref(card.href, locale)}
              className="block h-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition-colors"
            >
              <div className="text-2xl mb-2" aria-hidden>
                {card.icon}
              </div>
              <h2 className="text-lg font-semibold mb-1">{card.title}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{card.blurb}</p>
              <p className="text-xs font-medium text-blue-600 dark:text-blue-400">{card.stat}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
