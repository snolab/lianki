import Image from "next/image";
import type { Metadata } from "next";
import { authEmail, authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import { LanguageSwitcher } from "@/app/components/LanguageSwitcher";
import { generateHreflangMetadata } from "@/lib/hreflang";
import PreferencesClient from "./PreferencesClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "Preferences - Lianki",
    description: "Configure your Lianki preferences and settings",
    ...generateHreflangMetadata(locale, "/preferences"),
  };
}

export default async function PreferencesPage() {
  const email = await authEmail();
  const user = await authUser();
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="py-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <a href={`/${locale}`} className="text-2xl font-bold hover:underline">
            {appName}
          </a>
          <nav className="flex items-center gap-6">
            <a href={`/${locale}/blog`} className="text-lg font-medium hover:underline">
              {nav.blog}
            </a>
            <a href={`/${locale}/polyglot`} className="text-lg font-medium hover:underline">
              Polyglot
            </a>
            <a href={`/${locale}/list`} className="text-lg font-medium hover:underline">
              Dashboard
            </a>
            <a href="./lianki.user.js" className="text-lg font-medium hover:underline">
              Install
            </a>
            <LanguageSwitcher />
            <div className="relative group">
              <button className="flex items-center gap-2 text-lg font-medium hover:underline">
                {user.image && (
                  <Image
                    className="w-6 h-6 rounded-full"
                    alt="avatar"
                    src={user.image}
                    width={24}
                    height={24}
                  />
                )}
                <span>{user.name}</span>
              </button>
              <div className="hidden group-hover:block absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg py-1 z-10">
                <a
                  href={`/${locale}/profile`}
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Profile
                </a>
                <a
                  href={`/${locale}/preferences`}
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 bg-gray-100 dark:bg-gray-700"
                >
                  Preferences
                </a>
                <a
                  href={`/${locale}/membership`}
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Membership
                </a>
                <div className="block px-4 py-2 text-sm text-gray-500">{email}</div>
                <a
                  href="/auth/logout"
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Sign out
                </a>
              </div>
            </div>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow">
        <PreferencesClient />
      </main>
    </div>
  );
}
