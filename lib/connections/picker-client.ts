"use client";
// The Google Picker in the browser (docs/connections.md, "Importing a private
// doc"). Under `drive.file`, Lianki may open a Drive file only after the user
// picks it here; the Picker opens on the doc whose link they pasted
// (DocsView.setFileIds), so one click grants exactly that file.
//
// Loaded on demand from apis.google.com (Google's only way to ship the
// Picker), never on page load. The access token handed to it is short-lived
// (≤ 1 h, drive.file only) and kept in this closure only.

import { GOOGLE_DOC_MIME_TYPE } from "./scopes";

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
  Action: { PICKED: string; CANCEL: string };
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
let loading: Promise<PickerNS> | null = null;

function loadPicker(): Promise<PickerNS> {
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  if (loading) return loading;
  loading = new Promise<PickerNS>((resolve, reject) => {
    const done = () =>
      window.gapi!.load("picker", {
        callback: () => (window.google?.picker ? resolve(window.google.picker) : reject()),
        onerror: () => reject(new Error("picker-load")),
      });
    if (window.gapi) return done();
    const s = document.createElement("script");
    s.src = API_JS;
    s.async = true;
    s.onload = done;
    s.onerror = () => reject(new Error("picker-load"));
    document.head.appendChild(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

export type PickerSetup = { accessToken: string; apiKey: string; appId: string };

/**
 * Show the Picker on one doc. Resolves with the picked doc's id, or null when
 * the user closed it. Only Google Docs documents can be picked.
 */
export async function pickGoogleDoc(
  setup: PickerSetup,
  docId: string | null,
): Promise<string | null> {
  const P = await loadPicker();
  return new Promise((resolve) => {
    const view = new P.DocsView(P.ViewId.DOCUMENTS);
    view.setMimeTypes(GOOGLE_DOC_MIME_TYPE);
    view.setIncludeFolders(false);
    view.setMode(P.DocsViewMode.LIST);
    if (docId) view.setFileIds(docId);
    let picker: Picker | null = null;
    const b = new P.PickerBuilder();
    b.addView(view);
    b.setOAuthToken(setup.accessToken);
    b.setDeveloperKey(setup.apiKey);
    b.setAppId(setup.appId);
    b.setOrigin(window.location.origin);
    b.setCallback((data: Record<string, unknown>) => {
      const action = data[P.Response.ACTION];
      if (action === P.Action.PICKED) {
        const doc = (data[P.Response.DOCUMENTS] as Record<string, unknown>[] | undefined)?.[0];
        const id = doc?.[P.Document.ID];
        picker?.dispose();
        resolve(typeof id === "string" ? id : null);
      } else if (action === P.Action.CANCEL) {
        picker?.dispose();
        resolve(null);
      }
    });
    picker = b.build();
    picker.setVisible(true);
  });
}
