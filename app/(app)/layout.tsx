import { IntlayerServerProvider } from "next-intlayer/server";
import { getIntlayer } from "intlayer";
import { LANG_TAGS, isRTLLocale } from "@/lib/constants";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { AppShell, type ShellLabels, type ShellUser } from "@/app/components/AppShell";
import type { FirstRunLabels } from "@/app/components/FirstRunChoice";
import { IntlayerClientProvider } from "../IntlayerClientProvider";
import { announceBuild } from "@/lib/announce-build";
import { cookies } from "next/headers";
import { InviteClaim } from "@/app/components/InviteClaim";
import { PrefSync } from "@/app/components/PrefSync";
import { INVITE_COOKIE } from "@/lib/referrals/cookie";
import { LIVE_VIEW_COOKIE, liveViewFor } from "@/lib/live-view/shell.server";
import type { LiveViewLabels } from "@/app/components/LiveView";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  announceBuild();
  const locale = await appLocale();
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

  const { appName, nav } = getIntlayer("landing-page", locale);
  const shell = getIntlayer("app-shell", locale);
  const firstRun = getIntlayer("first-run", locale) as unknown as FirstRunLabels;

  // `nav` covers blog/learn/import/aiVocab/roadmap/polyglot; `shell.nav` adds
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
          <AppShell
            locale={locale}
            appName={appName}
            labels={labels}
            user={user}
            firstRun={firstRun}
            liveView={liveView}
          >
            {pendingInvite && <InviteClaim />}
            <PrefSync signedIn={Boolean(user)} />
            {children}
          </AppShell>
        </div>
      </IntlayerClientProvider>
    </IntlayerServerProvider>
  );
}
