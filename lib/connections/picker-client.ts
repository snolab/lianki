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
 */
export async function pickGoogleDocs(
  setup: PickerSetup,
  o: { docId?: string | null; multi?: boolean } = {},
): Promise<string[]> {
  const P = await loadPicker();
  return new Promise((resolve) => {
    const view = new P.DocsView(P.ViewId.DOCUMENTS);
    view.setMimeTypes(GOOGLE_DOC_MIME_TYPE);
    view.setIncludeFolders(false);
    view.setMode(P.DocsViewMode.LIST);
    if (o.docId) view.setFileIds(o.docId);
    let picker: Picker | null = null;
    const b = new P.PickerBuilder();
    b.addView(view);
    if (o.multi) b.enableFeature(P.Feature.MULTISELECT_ENABLED);
    b.setOAuthToken(setup.accessToken);
    b.setDeveloperKey(setup.apiKey);
    b.setAppId(setup.appId);
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
      }
    });
    picker = b.build();
    picker.setVisible(true);
  });
}
