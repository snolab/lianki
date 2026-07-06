import { type IntlayerConfig } from "intlayer";

// Minimal intlayer config for the SPA (no SSR / no locale URL routing — the
// client picks locale at runtime). A fuller port would mirror the root config's
// 16 locales; this proves the react-intlayer + vite-intlayer build on Vite.
const config: IntlayerConfig = {
  internationalization: {
    locales: ["en", "ja", "zh", "ko"],
    defaultLocale: "en",
  },
};

export default config;
