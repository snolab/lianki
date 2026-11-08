import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { voiceAccess } from "@/lib/words/voice-access";
import { isOwner } from "@/lib/owner";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import WordsClient from "./WordsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "Word lists - Lianki",
    description: "Fast vocabulary review: a screen of words at once, graded by exception, on FSRS.",
    ...generateAppHreflangMetadata(locale, "/words"),
  };
}

export default async function WordsPage() {
  // The (app) layout supplies the shell, auth and the Intlayer providers.
  // Voice mode (docs/voice-mode.md): the flag for everyone, else an owner preview.
  const [user, flags] = await Promise.all([authUserOrNull(), readFlags()]);
  return (
    <WordsClient
      voice={voiceAccess(flags, isDev(user?.email))}
      ytSongs={!!user && ytSongsOn(flags, isOwner(user.email ?? null))}
    />
  );
}
