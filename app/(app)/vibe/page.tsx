import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { vibeAllowed } from "@/lib/vibe/gate";
import VibeClient from "./VibeClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("vibe-page", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

/**
 * /vibe (docs/vibe.md): 404 unless `read.vibe` is on and this is the owner. The
 * flag has no owner bypass: with it off, nobody gets this page or its routes.
 */
export default async function VibePage() {
  const user = await authUserOrNull();
  if (!user?.id || dbBackend() !== "d1") notFound();
  if (!vibeAllowed(await readFlags(), isOwner(user.email ?? null))) notFound();
  return <VibeClient locale={await appLocale()} />;
}
