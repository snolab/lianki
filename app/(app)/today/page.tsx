import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import TodayClient from "./TodayClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title } = getIntlayer("today-page", locale);
  return { title: `${title} - Lianki`, ...generateAppHreflangMetadata(locale, "/today") };
}

/** Today's goal, full screen (lib/today/goal.ts). Behind `today.goal`, on by default. */
export default async function TodayPage() {
  const [user, flags] = await Promise.all([authUserOrNull(), readFlags()]);
  if (!flags["today.goal"]) notFound();
  if (!user) redirect("/sign-in");
  return <TodayClient />;
}
