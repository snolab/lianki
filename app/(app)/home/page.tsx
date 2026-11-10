import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import HomeClient from "./HomeClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title } = getIntlayer("nav-home", locale);
  return { title: `${title} - Lianki`, ...generateAppHreflangMetadata(locale, "/home") };
}

/** Home: where signing in lands — navigation and onboarding, word lists first. */
export default async function HomePage() {
  const [user, flags] = await Promise.all([
    authUserOrNull(),
    dbBackend() === "d1" ? readFlags() : null,
  ]);
  return (
    <HomeClient
      isLoggedIn={!!user}
      todayGoal={!!flags?.["today.goal"]}
      dev={isDev(user?.email ?? null)}
    />
  );
}
