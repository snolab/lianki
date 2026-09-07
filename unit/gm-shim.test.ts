import { describe, it, expect, beforeEach, mock } from "bun:test";
import { installGmShim, loadGmCache } from "../packages/ext/src/gm-shim";

// Unit tests for the MV3 GM→chrome adapter (packages/ext/src/gm-shim.ts). No
// browser: we mock chrome.storage.local + fetch and assert the behaviour the
// userscript depends on — notably that GM_getValue is synchronous, served from a
// cache preloaded from (async) chrome.storage.

type G = Record<string, any>;
const g = globalThis as G;

function mockChrome() {
  const store: Record<string, unknown> = {};
  g.chrome = {
    storage: {
      local: {
        get: mock(async () => ({ ...store })),
        set: mock(async (o: Record<string, unknown>) => void Object.assign(store, o)),
        remove: mock(async (k: string) => void delete store[k]),
      },
    },
  };
  return store;
}

// One module instance for the run: bun:test has no `resetModules`, and
// cache-busting the specifier with a query string makes coverage credit a
// different path, so the real file reads as untested. Isolation comes from
// `loadGmCache()` clearing the cache instead — which is what it must do anyway.

describe("gm-shim", () => {
  beforeEach(() => {
    delete g.GM_getValue;
    delete g.GM_setValue;
    delete g.GM_deleteValue;
    delete g.GM_xmlhttpRequest;
  });

  it("GM_getValue reads the preloaded cache synchronously (with default fallback)", async () => {
    const store = mockChrome();
    store["gm:lk:token"] = "lk_abc";
    await loadGmCache();
    installGmShim();
    expect(g.GM_getValue("lk:token", "")).toBe("lk_abc");
    expect(g.GM_getValue("missing", "fallback")).toBe("fallback");
  });

  it("GM_setValue updates the cache and writes through to chrome.storage", async () => {
    const store = mockChrome();
    installGmShim();
    g.GM_setValue("count", 42);
    expect(g.GM_getValue("count")).toBe(42); // synchronous read-back
    expect(store["gm:count"]).toBe(42); // persisted (prefixed)
  });

  it("GM_deleteValue removes from cache and storage", async () => {
    const store = mockChrome();
    store["gm:x"] = "y";
    await loadGmCache();
    installGmShim();
    g.GM_deleteValue("x");
    expect(g.GM_getValue("x", "gone")).toBe("gone");
    expect("gm:x" in store).toBe(false);
  });

  it("GM_xmlhttpRequest maps a fetch response onto the GM onload shape", async () => {
    mockChrome();
    g.fetch = mock(async () => new Response("hello", { status: 200, headers: { "x-test": "1" } }));
    installGmShim();
    const resp = await new Promise<any>((resolve, reject) => {
      g.GM_xmlhttpRequest({ url: "https://lianki.com/api/x", onload: resolve, onerror: reject });
    });
    expect(resp.status).toBe(200);
    expect(resp.responseText).toBe("hello");
    expect(resp.responseHeaders).toContain("x-test: 1");
  });

  it("GM_xmlhttpRequest routes failures to onerror", async () => {
    mockChrome();
    g.fetch = mock(async () => {
      throw new Error("network down");
    });
    installGmShim();
    const err = await new Promise<any>((resolve) => {
      g.GM_xmlhttpRequest({ url: "https://x", onerror: resolve });
    });
    expect(String(err)).toContain("network down");
  });
});
