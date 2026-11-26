/** A browser isolation selector, never a credential, a grant, or a microphone command. */
import { dictationId } from "../packages/debug-chat/src/dictation-wire";
import { uuidv4 } from "../packages/debug-chat/src/uuid";
import type { GmStore } from "./pill-chat-trust";

export const PORTABLE_MIC_BROWSER_KEY = "lianki_browser_id";
export const PORTABLE_MIC_BROWSER_REQUEST = "lianki:mic-browser-request";
export const PORTABLE_MIC_BROWSER_STATE = "lianki:mic-browser-state";
const apps = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
]);

/** Lazily called by a first-party bridge or an explicitly activated target. */
export function portableMicBrowserId(gm: GmStore): string | null {
  try {
    const stored = gm.getValue(PORTABLE_MIC_BROWSER_KEY);
    if (dictationId(stored, 16)) return stored;
    const bid = uuidv4();
    gm.setValue(PORTABLE_MIC_BROWSER_KEY, bid);
    // A failed or replaced store must not silently create a tab-only id.
    return gm.getValue(PORTABLE_MIC_BROWSER_KEY) === bid ? bid : null;
  } catch {
    return null;
  }
}

export function startPortableMicBrowser(d: {
  gm: GmStore;
  doc: Document;
  win: Window;
  top: boolean;
  signal?: AbortSignal;
}): () => void {
  if (!d.top || !apps.has(d.doc.location?.origin) || d.signal?.aborted) return () => {};
  let stopped = false;
  const publish = () => {
    if (stopped || d.signal?.aborted) return;
    const bid = portableMicBrowserId(d.gm);
    if (!bid) return;
    // A string crosses the userscript/page realm; no callable GM API escapes.
    const Event = (d.win as Window & typeof globalThis).CustomEvent;
    d.doc.dispatchEvent(new Event(PORTABLE_MIC_BROWSER_STATE, { detail: JSON.stringify({ bid }) }));
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    d.doc.removeEventListener(PORTABLE_MIC_BROWSER_REQUEST, publish);
    d.signal?.removeEventListener("abort", stop);
  };
  d.doc.addEventListener(PORTABLE_MIC_BROWSER_REQUEST, publish);
  d.signal?.addEventListener("abort", stop, { once: true });
  publish();
  return stop;
}
