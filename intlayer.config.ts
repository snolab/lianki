import type { IntlayerConfig } from "intlayer";

const config: IntlayerConfig = {
  internationalization: {
    // en: English (default)
    // zh: Chinese Simplified (existing blog/cn/ files mapped via blogLocaleDir) // TODO: lets mv blogfile from cn to zh to keep consistants
    // ja: Japanese
    // ko: Korean
    locales: ["en", "zh", "ja", "ko"],
    defaultLocale: "en",
  },
  routing: {
    // No URL prefix changes — locale detected from cookie / Accept-Language header.
    // Blog pages already carry locale in their [locale] URL segment and pass it explicitly.
    mode: "no-prefix",
  },
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o",
    applicationContext:
      "Lianki is a spaced repetition learning app using the FSRS algorithm. It helps users memorize content with flashcards and offers premium features like Polyglot language learning with AI translations and text-to-speech.",
    temperature: 0.5,
  },
};

export default config;
