import { IntlayerServerProvider } from "next-intlayer/server";
import { getIntlayer } from "intlayer";
import { LANG_TAGS, isRTLLocale } from "@/lib/constants";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { AppShell, type ShellLabels, type ShellUser } from "@/app/components/AppShell";
import { IntlayerClientProvider } from "../IntlayerClientProvider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const locale = await appLocale();
  const lang = LANG_TAGS[locale] ?? locale;
  const dir = isRTLLocale(locale) ? "rtl" : "ltr";

  // Auth is optional across the whole app group — several pages (list, read,
  // data) have a guest mode, and the sign-in page itself lives in this group, so
  // the shell must never trigger authUser()'s redirect-to-/sign-in.
  const user = (await authUserOrNull()) as ShellUser;

  const { appName, nav } = getIntlayer("landing-page", locale);
  const shell = getIntlayer("app-shell", locale);

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
          <AppShell locale={locale} appName={appName} labels={labels} user={user}>
            {children}
          </AppShell>
        </div>
      </IntlayerClientProvider>
    </IntlayerServerProvider>
  );
}
