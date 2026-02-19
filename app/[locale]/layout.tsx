import type { Metadata } from "next";

const LOCALE_LABELS: Record<string, string> = {
  en: "en",
  cn: "zh-Hans",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    other: { "html-lang": LOCALE_LABELS[locale] ?? locale },
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
  const lang = LOCALE_LABELS[locale] ?? locale;

  return (
    <div lang={lang} className="min-h-screen">
      {children}
    </div>
  );
}
