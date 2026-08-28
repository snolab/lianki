// ==UserScript==
// @name        Lianki Dev Loader
// @namespace   lianki-dev
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @grant       GM_registerMenuCommand
// @version     1.0.0
// @author      lianki.com
// @description Loads Lianki from a running dev server, so you install this once instead of reinstalling the userscript on every change.
// @run-at      document-end
// @connect     localhost
// @connect     127.0.0.1
// @connect     trycloudflare.com
// ==/UserScript==

// Install this ONCE, then run `bun run dev:userscript`. Every page load fetches
// the current build from the dev server, so a save + reload is the whole loop.
//
// `vite --config vite.config.userscript.ts` serves the complete bundle at
// /lianki.user.js (not a thin HMR shim), so this only has to fetch and evaluate
// it.
//
// Two sources, switchable from the userscript-manager menu:
//   local   http://localhost:3002        (bun run dev:userscript)
//   tunnel  https://<name>.trycloudflare.com
// The tunnel case is why vite.config.userscript.ts sets
// `allowedHosts: [".trycloudflare.com"]` — it lets a phone run your laptop's
// build. A tunnel host other than trycloudflare.com will prompt for connect
// permission once.
//
// IMPORTANT: disable the production Lianki script while this is enabled, or
// both run on every page and each registers its own handlers.

(function () {
  "use strict";

  const DEFAULT_ORIGIN = "http://localhost:3002";
  const ORIGIN_KEY = "lkdev:origin";
  const SCRIPT_PATH = "/lianki.user.js";

  // Captured before `run()` shadows GM_info for the loaded script.
  const loaderInfo = typeof GM_info !== "undefined" ? GM_info : undefined;

  // Guard against this loader running twice on one document (frames, or a
  // manager that injects more than once).
  if (window.__liankiDevLoader) return;
  window.__liankiDevLoader = true;

  const readOrigin = () =>
    String(GM_getValue(ORIGIN_KEY, "") || DEFAULT_ORIGIN).replace(/\/+$/, "");

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Lianki dev: set dev server origin", () => {
      const next = prompt(
        "Lianki dev server origin\n\nLocal:  http://localhost:3002\nTunnel: https://<name>.trycloudflare.com",
        readOrigin(),
      );
      if (next === null) return;
      const trimmed = next.trim().replace(/\/+$/, "");
      if (trimmed) GM_setValue(ORIGIN_KEY, trimmed);
      else GM_deleteValue(ORIGIN_KEY);
      location.reload();
    });
  }

  const origin = readOrigin();

  /**
   * Evaluate the fetched build.
   *
   * Direct `eval` is deliberate: it runs in this function's scope, so the
   * bundle sees the GM_* functions granted above — `new Function(...)` would
   * evaluate globally and they would be undefined.
   */
  function run(code) {
    // Report the DEV build's version rather than the loader's. The bundle
    // compares GM_info.script.version against the server's x-lianki-version to
    // decide whether to prompt for an update; left as the loader's "1.0.0" it
    // would consider itself permanently out of date and prompt on every page.
    const version = (code.match(/@version\s+(\S+)/) || [])[1] || "0.0.0";
    // eslint-disable-next-line no-unused-vars -- shadows the global for the eval below
    const GM_info = {
      ...loaderInfo,
      script: { ...(loaderInfo && loaderInfo.script), version },
    };

    try {
      // eslint-disable-next-line no-eval
      eval(code);
      console.info(`[Lianki dev] loaded v${version} from ${origin}`);
    } catch (err) {
      console.error("[Lianki dev] the dev build threw while evaluating:", err);
    }
  }

  GM_xmlhttpRequest({
    method: "GET",
    url: origin + SCRIPT_PATH,
    // Skip the manager's cache: the whole point is to pick up the latest save.
    headers: { "cache-control": "no-cache" },
    onload: (res) => {
      if (res.status !== 200) {
        console.error(`[Lianki dev] ${origin}${SCRIPT_PATH} returned HTTP ${res.status}`);
        return;
      }
      if (!/==UserScript==/.test(res.responseText)) {
        // Usually an HTML error page or a tunnel interstitial rather than JS.
        console.error(`[Lianki dev] ${origin}${SCRIPT_PATH} did not return a userscript`);
        return;
      }
      run(res.responseText);
    },
    onerror: () => {
      console.error(
        `[Lianki dev] could not reach ${origin}. Start it with \`bun run dev:userscript\`, ` +
          `or set another origin from the userscript menu.`,
      );
    },
  });
})();
