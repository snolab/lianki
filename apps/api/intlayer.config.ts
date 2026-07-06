import { type IntlayerConfig } from "intlayer";

// This Worker serves the @lianki/web SPA, so intlayer must compile the same
// dictionaries — point contentDir at apps/web's source (plus any local content).
const config: IntlayerConfig = {
  internationalization: {
    locales: ["en", "ja", "zh", "ko"],
    defaultLocale: "en",
  },
  content: {
    contentDir: ["src", "../web/src"],
  },
};

export default config;
