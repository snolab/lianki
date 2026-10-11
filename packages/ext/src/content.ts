// MV3 content-script entry for the TOP frame: the whole of Lianki.
// Subframes get frame.ts instead — see the manifest.
import { installGmShim, loadGmCache } from "./gm-shim";

const KEY_RELAY = "lianki:hotkey";

async function boot() {
  // Benign marker: lets pages / tests detect the extension is present and its
  // content script executed (the isolated world still shares document with the
  // page). Set before async work so it's observable immediately.
  document.documentElement.dataset.liankiExt = "loaded";
  installGmShim();
  await loadGmCache();
  // Readiness marker: set only after the async chrome.storage read completes, so
  // pages/tests can tell GM_getValue is now serving real cached values.
  document.documentElement.dataset.liankiReady = "1";
  // The Tampermonkey userscript is authored as an IIFE that runs on load and
  // reads the GM_* globals installed above. Reuse it as the single source of
  // truth for behaviour (one core, two targets). Dynamic import so it executes
  // only after the shim + cache are ready.
  await import("../../../src/lianki.user.ts");

  // Keys relayed out of a frame arrive here, vouched for by the browser.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === KEY_RELAY) {
      (globalThis as { __liankiRelayKey?: (k: unknown) => void }).__liankiRelayKey?.(msg);
    }
  });
}

// Top frame only — the manifest keeps this entry out of subframes, where
// frame.ts does the one job that has to happen there.
void boot();
