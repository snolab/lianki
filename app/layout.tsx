import { MOTION_BOOT_SCRIPT } from "@/lib/motion-boot";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { IntlayerServerProvider } from "next-intlayer/server";
import { getIntlayer } from "intlayer";
import { cookies, headers } from "next/headers";
import type { PartnerStrings } from "./components/DebugEval";
import { OwnerBoots } from "./components/OwnerBoots";
import { LOCALE_HEADER, PARTNER_FRAME_HEADER, resolveLocale } from "@/lib/app-locale";
import { LANG_TAGS } from "@/lib/constants";

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

/**
 * The status bar (and the notch around it) takes the page's paper colour, not
 * the seal red, light and dark alike (--background in globals.css).
 * viewportFit "cover" lets the page run under the notch and home indicator and
 * makes env(safe-area-inset-*) real; fixed bars pad themselves with it.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "oklch(0.945 0.02 82)" },
    { media: "(prefers-color-scheme: dark)", color: "oklch(0.18 0.01 65)" },
  ],
  viewportFit: "cover",
};

async function getRootLocale() {
  const h = await headers();
  // App routes resolve their locale in middleware (?lang= / cookie /
  // Accept-Language) and pass it in LOCALE_HEADER; <html lang> must match the
  // UI they render, not intlayer's prefix locale.
  const appLang = h.get(LOCALE_HEADER);
  if (appLang) return resolveLocale(appLang);
  const c = await cookies();
  return h.get("x-intlayer-locale") ?? c.get("INTLAYER_LOCALE")?.value ?? "en";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getRootLocale();
  // /embed/partner (framable by any site): none of the owner's page boots.
  const partnerFrame = (await headers()).get(PARTNER_FRAME_HEADER) === "1";
  // The chat's user-facing name and strings ("Learning Partner"; code: debug).
  const partner = Object.fromEntries(
    Object.entries(getIntlayer("learning-partner", locale as never)).map(([k, v]) => [
      k,
      String(v),
    ]),
  ) as unknown as PartnerStrings;
  return (
    <html lang={LANG_TAGS[locale] ?? locale} suppressHydrationWarning>
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
        {/* "Turn off animations" (lib/motion-pref.ts), before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT_SCRIPT }} />
        {/* Embed mode: inside an iframe (an overlay preview) or with ?embed=1, the
            page shows its content only, on a transparent background. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(self!==top||/[?&]embed=1(&|$)/.test(location.search))document.documentElement.dataset.embed=""}catch(e){document.documentElement.dataset.embed=""}`,
          }}
        />
      </head>
      <body>
        <IntlayerServerProvider locale={locale}>
          {partnerFrame ? null : <OwnerBoots strings={partner} />}
          {children}
        </IntlayerServerProvider>
      </body>
    </html>
  );
}
