import type { Metadata } from "next";
import { IntlayerServerProvider } from "next-intlayer/server";
import { LANG_TAGS } from "@/lib/constants";
import { generateHreflangMetadata } from "@/lib/hreflang";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;

  return {
    ...generateHreflangMetadata(locale, "/"),
    other: { "html-lang": LANG_TAGS[locale] ?? locale },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const lang = LANG_TAGS[locale] ?? locale;

  return (
    // Override the root layout's locale provider with the URL locale
    <IntlayerServerProvider locale={locale}>
      <div lang={lang} className="min-h-screen">
        {children}
      </div>
    </IntlayerServerProvider>
  );
}
