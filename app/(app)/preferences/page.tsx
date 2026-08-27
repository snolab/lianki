import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import PreferencesClient from "./PreferencesClient";
import { appLocale } from "@/lib/app-locale.server";
import { authEmail } from "@/app/signInEmail";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("preferences-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/preferences"),
  };
}

export default async function PreferencesPage() {
  // Auth guard, not a leftover: authEmail() redirects guests to /sign-in.
  // Without it PreferencesClient mounts for guests and 401s on /api/preferences.
  await authEmail();

  return (
    <div className="flex flex-col">
      {/* Main Content */}
      <div className="flex-grow">
        <PreferencesClient />
      </div>
    </div>
  );
}
