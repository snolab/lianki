// The Google Picker's first-open guards (docs/connections.md, "Picker
// guards"): a setup is checked before Google sees it, the Picker is built
// only after gapi.load("picker") called back and the page is in front, an
// error the Picker reports is thrown, and the pick is tried once more with a
// fresh setup. Window, document and Google's Picker are stubbed here.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PICKER_APP_ID_RE,
  PICKER_KEY_RE,
  PickerError,
  parsePickerSetup,
  pickWithRetry,
} from "@/lib/connections/picker-setup";
import { fetchSetup, pickAndImport, type Fetch } from "@/lib/connections/drive-pick";
import { pickerConfig } from "@/lib/connections/google";
import { loadPicker, pickGoogleDoc, pickGoogleDocs } from "@/lib/connections/picker-client";

const SETUP = {
  accessToken: "ya29.fake-test-token",
  apiKey: "AIzaFakeTestKey_000000000000",
  appId: "123456789012",
};
const A = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

describe("parsePickerSetup", () => {
  it("accepts a well-formed setup, a numeric app id as text", () => {
    expect(parsePickerSetup(SETUP)).toEqual(SETUP);
    expect(parsePickerSetup({ ...SETUP, appId: 123456789012 })).toEqual(SETUP);
  });

  it("refuses an error body, a missing or garbled field", () => {
    for (const bad of [
      null,
      "x",
      { error: "not-connected" },
      { ...SETUP, apiKey: "" },
      { ...SETUP, apiKey: undefined },
      { ...SETUP, apiKey: "has spaces in it 0000000000" },
      { ...SETUP, appId: "" },
      { ...SETUP, appId: "12-3" },
      { ...SETUP, accessToken: "" },
      { ...SETUP, accessToken: 42 },
    ])
      expect(parsePickerSetup(bad)).toBeNull();
  });

  it("is the same rule the server applies to its config", () => {
    expect(PICKER_KEY_RE.test(SETUP.apiKey)).toBe(true);
    expect(PICKER_APP_ID_RE.test(SETUP.appId)).toBe(true);
    expect(
      pickerConfig({ GOOGLE_PICKER_API_KEY: SETUP.apiKey, GOOGLE_PICKER_APP_ID: SETUP.appId }),
    ).toEqual({ apiKey: SETUP.apiKey, appId: SETUP.appId });
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: "short", GOOGLE_PICKER_APP_ID: "1" })).toBeNull();
  });
});

describe("pickWithRetry", () => {
  it("one try when it works; other outcomes pass through untouched", async () => {
    let fetches = 0;
    const got = await pickWithRetry(
      async () => (fetches++, { setup: SETUP }),
      async () => [A],
    );
    expect(got).toEqual({ ids: [A] });
    expect(fetches).toBe(1);
    expect(
      await pickWithRetry(
        async () => ({ other: "consent" }),
        async () => [A],
      ),
    ).toEqual({ other: "consent" });
  });

  it("a Picker error: once more with a fresh setup, then gives up", async () => {
    let fetches = 0;
    let picks = 0;
    const once = await pickWithRetry(
      async () => (fetches++, { setup: SETUP }),
      async () => {
        if (picks++ === 0) throw new PickerError("picker-error");
        return [A];
      },
    );
    expect(once).toEqual({ ids: [A] });
    expect([fetches, picks]).toEqual([2, 2]);

    picks = 0;
    await expect(
      pickWithRetry(
        async () => ({ setup: SETUP }),
        async () => {
          picks++;
          throw new PickerError("picker-error");
        },
      ),
    ).rejects.toBeInstanceOf(PickerError);
    expect(picks).toBe(2);
  });

  it("a malformed setup never reaches the Picker; the retry fetches again", async () => {
    const seen: unknown[] = [];
    let n = 0;
    const got = await pickWithRetry(
      async () => ({ setup: n++ === 0 ? { ...SETUP, apiKey: "" } : SETUP }),
      async (s) => (seen.push(s), [A]),
    );
    expect(got).toEqual({ ids: [A] });
    expect(seen).toEqual([SETUP]);
  });

  it("any other failure is not retried", async () => {
    let picks = 0;
    await expect(
      pickWithRetry(
        async () => ({ setup: SETUP }),
        async () => {
          picks++;
          throw new Error("other");
        },
      ),
    ).rejects.toThrow("other");
    expect(picks).toBe(1);
  });
});

describe("pickAndImport: first open fails, the retry opens it", () => {
  it("an error body on the first token request, then the setup", async () => {
    let n = 0;
    const f = (async (url: string) => {
      if (url === "/api/connections/google/picker")
        return new Response(n++ === 0 ? "<html>oops" : JSON.stringify(SETUP), { status: 200 });
      return new Response(JSON.stringify({ id: "book", title: "T" }), { status: 200 });
    }) as Fetch;
    const out = await pickAndImport("/reader", {
      fetch: f,
      pick: async (s) => (expect(s).toEqual(SETUP), [A]),
      connect: async () => "ok",
    });
    expect(out).toEqual({ kind: "done", imported: [{ id: "book", title: "T" }], failed: [] });
    expect(n).toBe(2);
  });

  it("the Picker reports an error twice: says it failed", async () => {
    const f = (async () => new Response(JSON.stringify(SETUP), { status: 200 })) as Fetch;
    let picks = 0;
    const out = await pickAndImport("/reader", {
      fetch: f,
      pick: async () => {
        picks++;
        throw new PickerError("picker-error");
      },
      connect: async () => "ok",
    });
    expect(out).toEqual({ kind: "error", code: "failed" });
    expect(picks).toBe(2);
  });

  it("fetchSetup: a thrown request is a bad setup (retried), not a crash", async () => {
    const boom = (() => Promise.reject(new Error("offline"))) as unknown as Fetch;
    expect(await fetchSetup(boom)).toEqual({ setup: null });
  });
});

// ── the browser side, with a stub window, document and Picker ──────────────

type Listener = () => void;
class FakeScript {
  src = "";
  async = false;
  on: Record<string, Listener[]> = {};
  addEventListener(t: string, l: Listener) {
    (this.on[t] ??= []).push(l);
  }
  fire(t: string) {
    for (const l of this.on[t] ?? []) l();
  }
}

type Built = { key?: unknown; appId?: unknown; token?: unknown; origin?: unknown; cb?: Function };

function stubPicker(log: { built: Built[]; disposed: number }) {
  return {
    ViewId: { DOCUMENTS: "docs" },
    DocsViewMode: { LIST: "list" },
    Feature: { MULTISELECT_ENABLED: "multi" },
    Action: { PICKED: "picked", CANCEL: "cancel", ERROR: "error" },
    Response: { ACTION: "action", DOCUMENTS: "docs" },
    Document: { ID: "id", MIME_TYPE: "mimeType" },
    DocsView: class {
      setFileIds() {}
      setMimeTypes() {}
      setMode() {}
      setIncludeFolders() {}
    },
    PickerBuilder: class {
      b: Built = {};
      addView() {}
      enableFeature() {}
      setOAuthToken(t: unknown) {
        this.b.token = t;
      }
      setDeveloperKey(k: unknown) {
        this.b.key = k;
      }
      setAppId(a: unknown) {
        this.b.appId = a;
      }
      setOrigin(o: unknown) {
        this.b.origin = o;
      }
      setCallback(cb: Function) {
        this.b.cb = cb;
      }
      build() {
        log.built.push(this.b);
        return { setVisible() {}, dispose: () => log.disposed++ };
      }
    },
  };
}

describe("picker-client in a stub browser", () => {
  const g = globalThis as Record<string, unknown>;
  let scripts: FakeScript[];
  let docListeners: Record<string, Listener[]>;
  let doc: { visibilityState: string };
  let log: { built: Built[]; disposed: number };
  let pendingLoad: (() => void) | null;

  beforeEach(() => {
    scripts = [];
    docListeners = {};
    log = { built: [], disposed: 0 };
    pendingLoad = null;
    doc = {
      visibilityState: "visible",
      querySelector: (sel: string) => scripts.find((s) => sel.includes(s.src)) ?? null,
      createElement: () => new FakeScript(),
      head: { appendChild: (s: FakeScript) => scripts.push(s) },
      addEventListener: (t: string, l: Listener) => (docListeners[t] ??= []).push(l),
      removeEventListener: (t: string, l: Listener) =>
        (docListeners[t] = (docListeners[t] ?? []).filter((x) => x !== l)),
    } as unknown as { visibilityState: string };
    g.document = doc;
    g.window = { location: { origin: "https://lianki.test" } };
  });
  afterEach(() => {
    delete g.window;
    delete g.document;
  });

  const w = () => g.window as Record<string, unknown>;
  /** api.js arrives: gapi exists; its picker module loads when `finish` is called. */
  const apiJsArrives = (picker: unknown) => {
    w().gapi = {
      load: (_n: string, o: { callback: () => void }) => {
        pendingLoad = () => {
          w().google = { picker };
          o.callback();
        };
      },
    };
    scripts[0].fire("load");
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("never builds before gapi.load calls back; one api.js for two callers", async () => {
    const P = stubPicker(log);
    const first = pickGoogleDocs(SETUP, { multi: true });
    const second = loadPicker();
    await tick();
    expect(scripts).toHaveLength(1);
    apiJsArrives(P);
    await tick();
    expect(log.built).toHaveLength(0); // the picker module has not called back
    pendingLoad!();
    await second;
    await tick();
    expect(log.built).toHaveLength(1);
    const b = log.built[0];
    expect([b.key, b.appId, b.token, b.origin]).toEqual([
      SETUP.apiKey,
      SETUP.appId,
      SETUP.accessToken,
      "https://lianki.test",
    ]);
    b.cb!({ action: "picked", docs: [{ id: A }, { id: 7 }] });
    expect(await first).toEqual([A]);
    expect(log.disposed).toBe(1);
  });

  it("an error the Picker reports is thrown; a close is no pick", async () => {
    w().google = { picker: stubPicker(log) };
    const p = pickGoogleDocs(SETUP);
    await tick();
    log.built[0].cb!({ action: "error" });
    await expect(p).rejects.toMatchObject({ code: "picker-error" });

    const q = pickGoogleDoc(SETUP, A);
    await tick();
    log.built[1].cb!({ action: "loaded" }); // ignored
    log.built[1].cb!({ action: "cancel" });
    expect(await q).toBeNull();
    expect(log.disposed).toBe(2);
  });

  it("a bad setup is never built", async () => {
    w().google = { picker: stubPicker(log) };
    await expect(pickGoogleDocs({ ...SETUP, apiKey: "" })).rejects.toMatchObject({
      code: "bad-setup",
    });
    expect(log.built).toHaveLength(0);
  });

  it("a half-loaded namespace counts as not loaded; the next try loads again", async () => {
    const p = pickGoogleDocs(SETUP);
    await tick();
    apiJsArrives({}); // google.picker without a PickerBuilder
    pendingLoad!();
    await expect(p).rejects.toMatchObject({ code: "picker-load" });
    // gapi is there now: the next try calls gapi.load again, no new api.js.
    w().gapi = {
      load: (_n: string, o: { callback: () => void }) => {
        w().google = { picker: stubPicker(log) };
        o.callback();
      },
    };
    expect(typeof (await loadPicker()).PickerBuilder).toBe("function");
    expect(scripts).toHaveLength(1);
  });

  it("api.js that fails to load, or gapi.load's own error", async () => {
    const p = loadPicker();
    scripts[0].fire("error");
    await expect(p).rejects.toThrow("picker-load");
    w().gapi = { load: (_n: string, o: { onerror: () => void }) => o.onerror() };
    await expect(loadPicker()).rejects.toThrow("picker-load");
    // An api.js tag already in the page is waited on, not added twice.
    w().gapi = undefined;
    const q = loadPicker();
    expect(scripts).toHaveLength(1);
    scripts[0].fire("load"); // fired, but no gapi
    await expect(q).rejects.toThrow("picker-load");
  });

  it("waits for the page to come to the front before building", async () => {
    w().google = { picker: stubPicker(log) };
    doc.visibilityState = "hidden";
    const p = pickGoogleDocs(SETUP);
    await tick();
    expect(log.built).toHaveLength(0);
    for (const l of [...(docListeners.visibilitychange ?? [])]) l(); // still hidden
    await tick();
    expect(log.built).toHaveLength(0);
    doc.visibilityState = "visible";
    for (const l of [...(docListeners.visibilitychange ?? [])]) l();
    await tick();
    expect(log.built).toHaveLength(1);
    expect(docListeners.visibilitychange).toHaveLength(0);
    log.built[0].cb!({ action: "cancel" });
    expect(await p).toEqual([]);
  });
});
