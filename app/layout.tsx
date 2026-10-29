import type { Metadata, Viewport } from "next";
import "./globals.css";
import { IntlayerServerProvider } from "next-intlayer/server";
import { cookies, headers } from "next/headers";
import { ServiceWorkerRegistration } from "./components/ServiceWorkerRegistration";
import { NewVersionNotice } from "./components/NewVersionNotice";
import { DebugEval } from "./components/DebugEval";

export const metadata: Metadata = {
  title: "Lianki",
  description: "Spaced repetition learning with the FSRS algorithm",
  manifest: "/manifest.json",
  // The seal (煉, 印泥 red) — public/icon.svg; PNGs for home screens.
  icons: {
    // ?v= busts browsers' sticky favicon caches (Chrome kept showing the old
    // Next.js icon). Bump it whenever the icon files change.
    icon: [{ url: "/icon.svg?v=3", type: "image/svg+xml" }, { url: "/favicon.ico?v=3" }],
    apple: "/apple-icon.png?v=3",
  },
  // Opened from the iPhone home screen, Lianki runs without Safari's address bar.
  appleWebApp: { capable: true, title: "Lianki", statusBarStyle: "default" },
};

/** Seal red (印泥), the brand colour: browser chrome on phones. */
// The status bar (and the notch around it) takes the page's paper colour, not
// the seal red, light and dark alike (--background in globals.css).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "oklch(0.945 0.02 82)" },
    { media: "(prefers-color-scheme: dark)", color: "oklch(0.18 0.01 65)" },
  ],
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
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Calligraphy theme fonts (all OFL). Both are sliced by unicode-range, so a
            page fetches only the chunks for the characters it shows — CJK fonts are
            ~10MB whole. Body: 霞鶩文楷 TC. Display: Yuji Syuku (brush), Zen Antique. */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-tc-web@1.522.0/lxgwwenkaitc-regular/result.css"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Yuji+Syuku&family=Zen+Antique&family=Cormorant+Garamond:wght@500;600&display=swap"
        />
        {/* The paper skin is per device; set it before first paint so the page
            never flashes the default. Key: PAPER_KEY in PaperSkinPicker. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var p=localStorage.getItem("lk:paper");if(p)document.documentElement.dataset.paper=p}catch(e){}`,
          }}
        />
      </head>
      <body>
        <IntlayerServerProvider locale={locale}>
          <ServiceWorkerRegistration />
          <NewVersionNotice />
          <DebugEval />
          {children}
        </IntlayerServerProvider>
      </body>
    </html>
  );
}
