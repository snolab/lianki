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
  build: {
    // Disable the @intlayer/babel call-site optimization: it only transforms
    // files inside this project, so it can't rewrite useIntlayer() in the
    // @lianki/web components this Worker bundles from ../web/src (result: blank
    // content). Off → runtime registry lookup via @intlayer/dictionaries-entry
    // (aliased in vite.config to the generated registry).
    optimize: false,
  },
};

export default config;
