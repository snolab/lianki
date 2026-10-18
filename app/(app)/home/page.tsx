import type { Metadata } from "next";
import { headers } from "next/headers";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { preferredImmersionLanguages } from "@/lib/immersion-sites";
import HomeClient from "./HomeClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("home-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/home"),
  };
}

export default async function HomePage() {
  const locale = await appLocale();
  // Guest-capable: signed-out visitors get the grid with their local mirror's
  // counts; signed-in ones get the cloud store's.
  const user = await authUserOrNull();
  const preferred = preferredImmersionLanguages((await headers()).get("accept-language"));
  return <HomeClient locale={locale} isLoggedIn={!!user} preferred={preferred} />;
}
