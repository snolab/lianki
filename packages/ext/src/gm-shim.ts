// GM_* → Chrome MV3 adapter. The Tampermonkey userscript uses GM APIs that
// don't exist in an MV3 content script; this shim provides them.
//
// The key impedance mismatch: GM_getValue/GM_setValue are SYNCHRONOUS, but
// chrome.storage is async. We resolve it by preloading all stored values into a
// synchronous in-memory cache (`loadGmCache`) BEFORE the userscript runs, then
// serving GM_getValue from the cache and writing through on GM_setValue.
//
// GM_xmlhttpRequest is reimplemented over fetch (content scripts may fetch the
// lianki.com hosts listed in manifest host_permissions), shaped to match the
// subset of the GM response the userscript reads (status, responseText,
// responseHeaders, onload/onerror).

/* global chrome */
declare const chrome: any;

const STORAGE_PREFIX = "gm:";
const cache = new Map<string, unknown>();

/** Load all gm: keys from chrome.storage.local into the sync cache. */
export async function loadGmCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(STORAGE_PREFIX)) cache.set(k.slice(STORAGE_PREFIX.length), v);
  }
}

function GM_getValue<T>(key: string, def?: T): T {
  return (cache.has(key) ? cache.get(key) : def) as T;
}

function GM_setValue(key: string, value: unknown): void {
  cache.set(key, value);
  void chrome.storage.local.set({ [STORAGE_PREFIX + key]: value });
}

function GM_deleteValue(key: string): void {
  cache.delete(key);
  void chrome.storage.local.remove(STORAGE_PREFIX + key);
}

type GMXHRDetails = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: BodyInit | null;
  withCredentials?: boolean;
  onload?: (resp: {
    status: number;
    responseText: string;
    responseHeaders: string;
    finalUrl: string;
  }) => void;
  onerror?: (err: unknown) => void;
};

function GM_xmlhttpRequest(details: GMXHRDetails): void {
  const { method = "GET", url, headers, data, withCredentials, onload, onerror } = details;
  fetch(url, {
    method,
    headers,
    body: data ?? undefined,
    credentials: withCredentials ? "include" : "same-origin",
  })
    .then(async (res) => {
      const responseHeaders = [...res.headers.entries()]
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      onload?.({
        status: res.status,
        responseText: await res.text(),
        responseHeaders,
        finalUrl: res.url,
      });
    })
    .catch((e) => onerror?.(e));
}

const GM_info = { script: { version: "2.23.17", name: "Lianki" } };

/** Install the GM_* shims onto the content-script global. */
export function installGmShim(): void {
  const g = globalThis as Record<string, unknown>;
  g.GM_getValue = GM_getValue;
  g.GM_setValue = GM_setValue;
  g.GM_deleteValue = GM_deleteValue;
  g.GM_xmlhttpRequest = GM_xmlhttpRequest;
  g.GM_info = GM_info;
}
