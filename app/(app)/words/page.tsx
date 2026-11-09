import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { voiceAccess } from "@/lib/words/voice-access";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { importAnyOn } from "@/lib/import/words-handler";
import { importAiOn } from "@/lib/import/ai-convert";
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
      ytSongs={!!user && ytSongsOn(flags, isDev(user.email))}
      // The Import button (docs/import-material.md, "On /words"): dark behind
      // `import.any`: every user while on; the owner on or off (importAnyOn).
      importOn={!!user && importAnyOn(flags, isDev(user.email))}
      // "Words with AI" on stored files: `words.import-ai` (on: everyone; off: dev holders); credits checked on open.
      importAiOn={!!user && importAiOn(flags, isDev(user.email))}
      // A two-finger vertical pinch sets the cards' height (lib/words/row-pinch.ts).
      pinch={flags["words.pinch-card-height"]}
      // The first-visit walkthrough and its "?" by the heading (lib/words/onboarding.ts).
      onboarding={flags["words.onboarding"]}
    />
  );
}
