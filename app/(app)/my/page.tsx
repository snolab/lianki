import type { Metadata } from "next";
import Link from "next/link";
import { getIntlayer } from "intlayer";
import { Icon, type IconName } from "@/app/components/icons";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("my-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    robots: { index: false, follow: false },
    ...generateAppHreflangMetadata(locale, "/my"),
  };
}

/**
 * /my (owner, 2026-11-10): the user's manager for all their Lianki data —
 * profile, preferences/settings, files — one card each (docs/url-principles.md).
 * Signed-in only; a guest goes to sign in.
 */
export default async function MyPage() {
  const user = await authUserOrNull();
  if (!user) return signInRedirect();
  const locale = await appLocale();
  const { heading, intro, cards } = getIntlayer("my-page", locale);

  const items: { key: string; href: string; icon: IconName; title: string; blurb: string }[] = [
    { key: "profile", href: "/my/profile", icon: "user", ...strs(cards.profile) },
    { key: "preferences", href: "/my/preferences", icon: "gearSix", ...strs(cards.preferences) },
    { key: "files", href: "/my/files", icon: "folderSimple", ...strs(cards.files) },
    { key: "data", href: "/data", icon: "database", ...strs(cards.data) },
  ];
  // Mic recordings (docs/recordings.md): only where the page exists — flag voice.recordings and `dev`.
  if (isDev(user.email) && flagIn(await readFlags(), "voice.recordings"))
    items.push({
      key: "recordings",
      href: "/my/recordings",
      icon: "microphone",
      ...strs(cards.recordings),
    });

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
        <Icon name="folder" />
        {heading}
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">{intro}</p>
      <ul className="grid gap-4 sm:grid-cols-2">
        {items.map((card) => (
          <li key={card.key}>
            <Link
              href={card.href}
              data-my-card={card.key}
              className="block h-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition-colors"
            >
              <Icon name={card.icon} className="text-2xl mb-2 block" />
              <h2 className="text-lg font-semibold mb-1">{card.title}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">{card.blurb}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

function strs(c: { title: unknown; blurb: unknown }) {
  return { title: String(c.title), blurb: String(c.blurb) };
}
