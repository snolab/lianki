// MV3 content-script entry. Order matters: install the GM shims and preload the
// synchronous storage cache BEFORE the userscript logic runs (it reads
// GM_getValue synchronously at startup).
import { installGmShim, loadGmCache } from "./gm-shim";

async function boot() {
  // Benign marker: lets pages / tests detect the extension is present and its
  // content script executed (the isolated world still shares document with the
  // page). Set before async work so it's observable immediately.
  document.documentElement.dataset.liankiExt = "loaded";
  installGmShim();
  await loadGmCache();
  // The Tampermonkey userscript is authored as an IIFE that runs on load and
  // reads the GM_* globals installed above. Reuse it as the single source of
  // truth for behaviour (one core, two targets). Dynamic import so it executes
  // only after the shim + cache are ready.
  await import("../../../src/lianki.user.ts");
}

void boot();
