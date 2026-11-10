import { IntlayerServerProvider } from "next-intlayer/server";
import { getIntlayer } from "intlayer";
import { LANG_TAGS, isRTLLocale } from "@/lib/constants";
import { appLocaleState } from "@/lib/app-locale.server";
import { AccountLocaleAdopt } from "@/app/components/AccountLocaleAdopt";
import { authUserOrNull } from "@/app/signInEmail";
import { AppShell, type ShellLabels, type ShellUser } from "@/app/components/AppShell";
import type { FirstRunLabels } from "@/app/components/FirstRunChoice";
import { IntlayerClientProvider } from "../IntlayerClientProvider";
import { announceBuild } from "@/lib/announce-build";
import { cookies } from "next/headers";
import { InviteClaim } from "@/app/components/InviteClaim";
import { PrefSync } from "@/app/components/PrefSync";
import { AppBadge } from "@/app/components/AppBadge";
import { appBadgeOn } from "@/lib/app-badge-gate";
import { INVITE_COOKIE } from "@/lib/referrals/cookie";
import { devSwitchFor } from "@/lib/dev-server-switch.server";
import type { DevSwitchLabels } from "@/app/components/DevSwitchItem";
import { LIVE_VIEW_COOKIE, liveViewFor } from "@/lib/live-view/shell.server";
import type { LiveViewLabels } from "@/app/components/LiveView";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { publicConfig } from "@/lib/config-store";
import { PublicConfig } from "@/app/components/PublicConfig";
import { isDev } from "@/lib/permissions";
import { booksMineOn, libraryOn } from "@/lib/books/gate";
import { levelsOn } from "@/lib/level-progress";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  announceBuild();
  // The signed-in account's language first, on the first response (lib/account-locale.ts).
  const localeState = await appLocaleState();
  const locale = localeState.locale;
  const lang = LANG_TAGS[locale] ?? locale;
  const dir = isRTLLocale(locale) ? "rtl" : "ltr";

  // Auth is optional across the whole app group — several pages (list, read,
  // data) have a guest mode, and the sign-in page itself lives in this group, so
  // the shell must never trigger authUser()'s redirect-to-/sign-in.
  const user = (await authUserOrNull()) as ShellUser;
  const jar = await cookies();
  const pendingInvite = Boolean(user) && jar.has(INVITE_COOKIE);
  // Live view (docs/live-view.md): the owner only; strings and pointer for nobody else.
  const liveView = await liveViewFor(
    user?.email,
    jar.get(LIVE_VIEW_COOKIE)?.value,
    () => getIntlayer("live-view", locale) as unknown as LiveViewLabels,
  );

  // Flag-gated nav items (lib/app-nav.ts `flag`): /books (My books, `books.mine`)
  // and /library (`library.catalogue`), both on for everyone by default; a `dev`
  // holder keeps them while off. readFlags is cached 30 s per isolate.
  const flags = dbBackend() === "d1" ? await readFlags() : null;
  const owner = isDev(user?.email ?? null);
  const navShown: string[] = [];
  if (booksMineOn(flags, owner)) navShown.push("books");
  if (libraryOn(flags, owner)) navShown.push("library");
  // Today's goal (/today): `today.goal`, on by default, for everyone.
  if (flags?.["today.goal"]) navShown.push("today");
  // The level chip by the avatar (docs/levels.md): signed in, D1, `levels` on or the owner.
  const levels = Boolean(user) && flags !== null && levelsOn(flags, owner);
  // The app-icon badge (docs/app-badge.md): signed in, D1, `pwa.app-badge` on, the owner only.
  const appBadge = Boolean(user) && flags !== null && appBadgeOn(flags, owner);

  // Public config values (docs/config-store.md): cached 30 s, the defaults off D1.
  const config = await publicConfig();

  const { appName, nav } = getIntlayer("landing-page", locale);
  const shell = getIntlayer("app-shell", locale);
  const firstRun = getIntlayer("first-run", locale) as unknown as FirstRunLabels;

  // `nav` covers blog/learn/import/aiVocab/roadmap/polyglot (the last two under Lab); `shell.nav` adds
  // the rest, including the account labels `landing-page` never declared.
  const labels = {
    ...(nav as unknown as Record<string, string>),
    ...(shell.nav as unknown as Record<string, string>),
    groups: shell.groups as unknown as ShellLabels["groups"],
    ui: shell.ui as unknown as ShellLabels["ui"],
  } as ShellLabels;

  return (
    <IntlayerServerProvider locale={locale}>
      <IntlayerClientProvider locale={locale}>
        <div lang={lang} dir={dir} className="min-h-screen">
          <PublicConfig values={config}>
            <AppShell
              locale={locale}
              appName={appName}
              labels={labels}
              user={user}
              firstRun={firstRun}
              devSwitch={devSwitchFor(
                user?.email,
                // Strings for the owner only: anyone else's page carries none of them.
                () => getIntlayer("dev-switch", locale) as unknown as DevSwitchLabels,
              )}
              liveView={liveView}
              navShown={navShown}
              levels={levels}
            >
              {pendingInvite && <InviteClaim />}
              <PrefSync signedIn={Boolean(user)} />
              {localeState.adopt && <AccountLocaleAdopt locale={localeState.adopt.locale} />}
              <AppBadge on={appBadge} />
              {children}
            </AppShell>
          </PublicConfig>
        </div>
      </IntlayerClientProvider>
    </IntlayerServerProvider>
  );
}
