"use client";
// The Google Picker in the browser (docs/connections.md, "Importing a private
// doc"). Under `drive.file`, Lianki may open a Drive file only after the user
// picks it here; the Picker opens on the doc whose link they pasted
// (DocsView.setFileIds), so one click grants exactly that file.
//
// Loaded on demand from apis.google.com (Google's only way to ship the
// Picker), never on page load. The access token handed to it is short-lived
// (≤ 1 h, drive.file only) and kept in this closure only.
//
// Guards ("The API developer key is invalid." on a first open, iPhone PWA,
// 2026-11-10): the setup is checked before Google sees it, the Picker is
// built only after `gapi.load("picker")` has called back with a usable
// namespace and the page is in front, and an error the Picker reports
// (`Action.ERROR`) is thrown as a PickerError so the caller can try once more.

import { GOOGLE_DOC_MIME_TYPE } from "./scopes";
import { PickerError, parsePickerSetup, type PickerSetup } from "./picker-setup";

export { PickerError, type PickerSetup };

type Picker = {
  setVisible(v: boolean): void;
  dispose(): void;
};

type PickerNS = {
  DocsView: new (viewId?: unknown) => {
    setFileIds(ids: string): unknown;
    setMimeTypes(m: string): unknown;
    setMode(m: unknown): unknown;
    setIncludeFolders(b: boolean): unknown;
  };
  PickerBuilder: new () => Record<string, (...a: unknown[]) => unknown> & { build(): Picker };
  ViewId: { DOCUMENTS: unknown };
  DocsViewMode: { LIST: unknown };
  Action: { PICKED: string; CANCEL: string; ERROR?: string };
  Feature: { MULTISELECT_ENABLED: unknown };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; MIME_TYPE: string };
};

declare global {
  interface Window {
    gapi?: { load(name: string, cb: { callback: () => void; onerror: () => void }): void };
    google?: { picker?: PickerNS };
  }
}

const API_JS = "https://apis.google.com/js/api.js";
/** How long api.js and the picker module may take before the load counts as failed. */
export const PICKER_LOAD_TIMEOUT_MS = 20_000;
let loading: Promise<PickerNS> | null = null;

/** The picker namespace once it is really usable, not a half-loaded object. */
function ready(): PickerNS | null {
  const P = window.google?.picker;
  return P && typeof P.PickerBuilder === "function" && typeof P.DocsView === "function" ? P : null;
}

/**
 * api.js, then `gapi.load("picker")`. Resolves only from the load callback
 * with a usable namespace, never before; a second caller waits on the same
 * load, and an api.js tag already in the page (an earlier attempt still
 * loading) is waited on instead of being added twice.
 */
export function loadPicker(): Promise<PickerNS> {
  const now = ready();
  if (now) return Promise.resolve(now);
  if (loading) return loading;
  loading = new Promise<PickerNS>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("picker-load")), PICKER_LOAD_TIMEOUT_MS);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("picker-load"));
    };
    const done = () => {
      if (!window.gapi) return fail();
      window.gapi.load("picker", {
        callback: () => {
          const P = ready();
          if (!P) return fail();
          clearTimeout(timer);
          resolve(P);
        },
        onerror: fail,
      });
    };
    if (window.gapi) return done();
    let s = document.querySelector<HTMLScriptElement>(`script[src="${API_JS}"]`);
    if (!s) {
      s = document.createElement("script");
      s.src = API_JS;
      s.async = true;
      document.head.appendChild(s);
    }
    s.addEventListener("load", done, { once: true });
    s.addEventListener("error", fail, { once: true });
  }).finally(() => {
    // Settled: a later call checks the namespace afresh (and loads again after a failure).
    loading = null;
  });
  return loading;
}

/** Resolves once the page is in front (back from Google's consent it may still be hidden). */
function whenVisible(): Promise<void> {
  if (document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", on);
      resolve();
    };
    document.addEventListener("visibilitychange", on);
  });
}

/** Show the Picker on one doc: the picked doc's id, or null when it was closed. */
export async function pickGoogleDoc(
  setup: PickerSetup,
  docId: string | null,
): Promise<string | null> {
  return (await pickGoogleDocs(setup, { docId }))[0] ?? null;
}

/**
 * Show the Picker. With `docId` it opens preselected on that doc; with
 * `multi` the user may tick several. Resolves with the picked docs' ids, or
 * none when the user closed it. Only Google Docs documents can be picked.
 * Throws a PickerError when the setup is not well formed (it never reaches
 * Google), the Picker does not load, or the Picker reports an error.
 */
export async function pickGoogleDocs(
  setup: PickerSetup,
  o: { docId?: string | null; multi?: boolean } = {},
): Promise<string[]> {
  const good = parsePickerSetup(setup);
  if (!good) throw new PickerError("bad-setup");
  let P: PickerNS;
  try {
    P = await loadPicker();
  } catch {
    throw new PickerError("picker-load");
  }
  await whenVisible();
  return new Promise((resolve, reject) => {
    const view = new P.DocsView(P.ViewId.DOCUMENTS);
    view.setMimeTypes(GOOGLE_DOC_MIME_TYPE);
    view.setIncludeFolders(false);
    view.setMode(P.DocsViewMode.LIST);
    if (o.docId) view.setFileIds(o.docId);
    let picker: Picker | null = null;
    const b = new P.PickerBuilder();
    b.addView(view);
    if (o.multi) b.enableFeature(P.Feature.MULTISELECT_ENABLED);
    b.setOAuthToken(good.accessToken);
    b.setDeveloperKey(good.apiKey);
    b.setAppId(good.appId);
    b.setOrigin(window.location.origin);
    b.setCallback((data: Record<string, unknown>) => {
      const action = data[P.Response.ACTION];
      if (action === P.Action.PICKED) {
        const docs = (data[P.Response.DOCUMENTS] as Record<string, unknown>[] | undefined) ?? [];
        picker?.dispose();
        resolve(
          docs.map((d) => d[P.Document.ID]).filter((id): id is string => typeof id === "string"),
        );
      } else if (action === P.Action.CANCEL) {
        picker?.dispose();
        resolve([]);
      } else if (P.Action.ERROR !== undefined && action === P.Action.ERROR) {
        picker?.dispose();
        reject(new PickerError("picker-error"));
      }
    });
    picker = b.build();
    picker.setVisible(true);
  });
}
