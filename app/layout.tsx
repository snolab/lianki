import type { Metadata } from "next";
import "./globals.css";
import { IntlayerServerProvider } from "next-intlayer/server";
import { cookies, headers } from "next/headers";

export const metadata: Metadata = {
  title: "Lianki",
  description: "Spaced repetition learning with the FSRS algorithm",
};

async function getRootLocale() {
  const h = await headers();
  const c = await cookies();
  return h.get("x-intlayer-locale") ?? c.get("INTLAYER_LOCALE")?.value ?? "en";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getRootLocale();
  return (
    <html lang={locale}>
      <body>
        <IntlayerServerProvider locale={locale}>{children}</IntlayerServerProvider>
      </body>
    </html>
  );
}
