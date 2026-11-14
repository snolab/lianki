import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import PreferencesClient from "./PreferencesClient";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { ByokSettings } from "@/app/components/ByokSettings";
import { readFlags } from "@/lib/flags-store";
import { flagIn } from "@/lib/flags";
import { isDev } from "@/lib/permissions";
import { appBadgeOn } from "@/lib/app-badge-gate";
import { vibeAllowed } from "@/lib/vibe/gate";
import { VibeRetention } from "../../vibe/VibeRetention";
import { dbBackend, getD1 } from "@/lib/d1";
import { listApps } from "@/lib/mini-apps/store";
import type { MiniDb } from "@/lib/mini-apps/store";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("preferences-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/my/preferences"),
  };
}

export default async function PreferencesPage() {
  // Guests get only what needs no account: "Your own AI" in browser-only mode
  // (docs/byok.md; syncing it needs a free account). PreferencesClient is for
  // signed-in users only: it would 401 on /api/preferences.
  const user = await authUserOrNull();
  if (!user?.email)
    return (
      <div className="mx-auto max-w-4xl p-8">
        <ByokSettings signedIn={false} />
      </div>
    );
  // The API key's account sync (managed mode) is only drawn, disabled, behind
  // `byok.sync`; the owner sees it while it is off (docs/byok.md).
  const flags = await readFlags();
  const showKeySync = isDev(user.email) || flagIn(flags, "byok.sync");
  const vibe = vibeAllowed(flags, isDev(user.email));
  // The app-icon badge's row (docs/app-badge.md): only while `pwa.app-badge` is on, the owner only.
  const appBadge = appBadgeOn(flags, isDev(user.email));
  // Mini apps (docs/mini-apps.md): the section only once the account has one.
  const miniApps =
    flagIn(flags, "mini-apps") &&
    dbBackend() === "d1" &&
    !!user.id &&
    (await listApps(getD1() as unknown as MiniDb, user.id).catch(() => [])).length > 0;

  return (
    <div className="flex flex-col">
      {/* Main Content */}
      <div className="flex-grow">
        <PreferencesClient
          showKeySync={showKeySync}
          appBadge={appBadge}
          hasVibe={vibe}
          miniApps={miniApps}
        >
          {vibe && <VibeRetention />}
        </PreferencesClient>
      </div>
    </div>
  );
}
