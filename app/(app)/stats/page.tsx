import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import StatsClient from "./StatsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const t = getIntlayer("stats-page", locale);
  return {
    title: t.metaTitle,
    description: t.metaDescription,
    ...generateAppHreflangMetadata(locale, "/stats"),
  };
}

export default async function StatsPage() {
  // The (app) layout supplies the shell, auth and the Intlayer providers, so the
  // page is just its client body. The server tells it whether a YouTube key is
  // configured (the language lookup needs one) and whether the viewer holds
  // `dev`, who alone is told when it is missing.
  const user = await authUserOrNull();
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <StatsClient youtubeKey={!!process.env.YOUTUBE_API_KEY} dev={isDev(user?.email ?? null)} />
      </div>
    </div>
  );
}
