import type { IntlayerConfig } from "intlayer";

const config: IntlayerConfig = {
  internationalization: {
    // en: English (default)
    // zh: Chinese Simplified (existing blog/cn/ files mapped via blogLocaleDir)
    // ja: Japanese
    locales: ["en", "zh", "ja"],
    defaultLocale: "en",
  },
  routing: {
    // No URL prefix changes — locale detected from cookie / Accept-Language header.
    // Blog pages already carry locale in their [locale] URL segment and pass it explicitly.
    mode: "no-prefix",
  },
};

export default config;
