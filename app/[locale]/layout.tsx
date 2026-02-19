import type { Metadata } from "next";
import { IntlayerServerProvider } from "next-intlayer/server";

// BCP47 lang tags for the HTML lang attribute
const LANG_TAG: Record<string, string> = {
  en: "en",
  zh: "zh-Hans",
  ja: "ja",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return { other: { "html-lang": LANG_TAG[locale] ?? locale } };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const lang = LANG_TAG[locale] ?? locale;

  return (
    // Override the root layout's locale provider with the URL locale
    <IntlayerServerProvider locale={locale}>
      <div lang={lang} className="min-h-screen">
        {children}
      </div>
    </IntlayerServerProvider>
  );
}
