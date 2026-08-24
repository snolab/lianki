import { IntlayerServerProvider } from "next-intlayer/server";
import { LANG_TAGS, isRTLLocale } from "@/lib/constants";
import { appLocale } from "@/lib/app-locale.server";
import { IntlayerClientProvider } from "../IntlayerClientProvider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const locale = await appLocale();
  const lang = LANG_TAGS[locale] ?? locale;
  const dir = isRTLLocale(locale) ? "rtl" : "ltr";

  return (
    <IntlayerServerProvider locale={locale}>
      <IntlayerClientProvider locale={locale}>
        <div lang={lang} dir={dir} className="min-h-screen">
          {children}
        </div>
      </IntlayerClientProvider>
    </IntlayerServerProvider>
  );
}
