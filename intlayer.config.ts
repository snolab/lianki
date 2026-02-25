import type { IntlayerConfig } from "intlayer";

const config: IntlayerConfig = {
  internationalization: {
    // Top 16 languages by number of speakers
    locales: [
      "en", // English
      "zh", // Chinese Simplified
      "hi", // Hindi
      "es", // Spanish
      "fr", // French
      "ar", // Arabic
      "bn", // Bengali
      "pt", // Portuguese
      "ru", // Russian
      "ur", // Urdu
      "id", // Indonesian
      "de", // German
      "ja", // Japanese
      "sw", // Swahili
      "mr", // Marathi
      "ko", // Korean
    ],
    defaultLocale: "en",
  },
  routing: {
    // Use URL prefixes for all locales including default (/en/, /zh/, /ja/, /ko/)
    // Blog pages already carry locale in their [locale] URL segment and are handled separately
    mode: "prefix-all",
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
