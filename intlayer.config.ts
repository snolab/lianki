import type { IntlayerConfig } from "intlayer";

const config: IntlayerConfig = {
  internationalization: {
    // Top 15 languages by total speakers + Korean (high demand for language learning)
    // en: English (default)
    // zh: Chinese Simplified
    // ja: Japanese
    // hi: Hindi
    // es: Spanish
    // fr: French
    // ar: Arabic (RTL)
    // bn: Bengali
    // pt: Portuguese
    // ru: Russian
    // ur: Urdu (RTL)
    // id: Indonesian
    // de: German
    // sw: Swahili
    // mr: Marathi
    // ko: Korean
    locales: [
      "en",
      "zh",
      "ja",
      "hi",
      "es",
      "fr",
      "ar",
      "bn",
      "pt",
      "ru",
      "ur",
      "id",
      "de",
      "sw",
      "mr",
      "ko",
    ],
    defaultLocale: "en",
  },
  routing: {
    // No URL prefix changes — locale detected from cookie / Accept-Language header.
    // Blog pages already carry locale in their [locale] URL segment and pass it explicitly.
    mode: "no-prefix",
  },
};

export default config;
