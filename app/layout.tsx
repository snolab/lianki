import type { Metadata } from "next";
import "./globals.css";
import { IntlayerServerProvider } from "next-intlayer/server";
import { locale as getLocale } from "next-intlayer/server";

export const metadata: Metadata = {
  title: "Lianki",
  description: "Spaced repetition learning with the FSRS algorithm",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = getLocale;
  return (
    <html lang={locale}>
      <body>
        <IntlayerServerProvider locale={locale}>{children}</IntlayerServerProvider>
      </body>
    </html>
  );
}
