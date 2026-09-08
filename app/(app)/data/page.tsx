import type { Metadata } from "next";
import { Suspense } from "react";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import DataClient from "./DataClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("data-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/data"),
  };
}

export default async function DataPage() {
  // Guest-capable: signed-out visitors manage the Local (IndexedDB) store.
  const user = await authUserOrNull();

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="max-w-6xl mx-auto">
        {/* useSearchParams() inside DataClient reads the filter state from the
            URL; Next requires it to sit under a Suspense boundary. */}
        <Suspense fallback={null}>
          <DataClient isLoggedIn={!!user} />
        </Suspense>
      </div>
    </div>
  );
}
