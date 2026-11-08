// "Choose from Google Drive" (docs/connections.md, "Picking docs"): the
// Picker opened straight away, no link needed, several Google Docs at once,
// each imported as the user's own book through POST /api/read/gdoc
// {via: "drive"} (source_key gdoc:<id>, so a re-import updates that book).
//
// Not connected yet, or the grant ended: Google's consent first, back to the
// page with `?pick=drive&google=connected`, where the Picker opens by itself
// (`autoPickOnReturn`). Everything that touches the network or Google's UI is
// passed in, so the flow is unit-tested without either.

import { gdocUrlOf } from "@/lib/gdoc/url";
import type { PickerSetup } from "./picker-client";

/** The `fetch` this needs (a plain function, so tests can pass one). */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The pages that offer the button; each comes back to itself after connecting. */
export type PickPage = "/connections" | "/reader";

/** Where Google's consent returns to: the page, marked to open the Picker. */
export function pickReturnTo(page: PickPage): string {
  return `${page}?pick=drive`;
}

/**
 * Back from Google's consent screen (`?pick=drive&google=<result>`): open the
 * Picker only when connecting worked and it was started from the pick
 * button, never on a plain visit or after a denial.
 */
export function autoPickOnReturn(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.get("pick") === "drive" && q.get("google") === "connected";
}

/** The URL's query without the pick/return words, so a reload does not repeat them. */
export function withoutPickParams(search: string): string {
  const q = new URLSearchParams(search);
  q.delete("pick");
  q.delete("google");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type Imported = { id: string; title: string };

export type PickOutcome =
  /** Gone to Google's consent screen (the page is leaving). */
  | { kind: "leaving" }
  /** The Picker was closed without picking. */
  | { kind: "cancelled" }
  | { kind: "done"; imported: Imported[]; failed: string[] }
  | { kind: "error"; code: "not-configured" | "failed" | "rate-limited" };

export type PickDeps = {
  fetch: Fetch;
  /** Google's Picker (lib/connections/picker-client.ts), multi-select. */
  pick: (setup: PickerSetup) => Promise<string[]>;
  /** To Google's consent screen (lib/connections/connect-client.ts). */
  connect: (returnTo: string) => Promise<"ok" | "not-configured" | "failed">;
  /** Each doc as it starts importing: 1-based index, count. */
  onProgress?: (done: number, total: number) => void;
};

const post = (f: Fetch, url: string, body: unknown) =>
  f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function toConsent(deps: PickDeps, page: PickPage): Promise<PickOutcome> {
  const r = await deps.connect(pickReturnTo(page));
  return r === "ok" ? { kind: "leaving" } : { kind: "error", code: r };
}

/** Open the Picker, then import every picked doc in turn. */
export async function pickAndImport(page: PickPage, deps: PickDeps): Promise<PickOutcome> {
  let setup: PickerSetup;
  try {
    const r = await post(deps.fetch, "/api/connections/google/picker", {});
    if (r.status === 503) return { kind: "error", code: "not-configured" };
    if (r.status === 409) return toConsent(deps, page);
    if (r.status === 429) return { kind: "error", code: "rate-limited" };
    if (!r.ok) return { kind: "error", code: "failed" };
    setup = (await r.json()) as PickerSetup;
  } catch {
    return { kind: "error", code: "failed" };
  }

  let ids: string[];
  try {
    ids = [...new Set(await deps.pick(setup))];
  } catch {
    return { kind: "error", code: "failed" };
  }
  if (!ids.length) return { kind: "cancelled" };

  const imported: Imported[] = [];
  const failed: string[] = [];
  for (const [i, id] of ids.entries()) {
    deps.onProgress?.(i + 1, ids.length);
    const res = await importOne(deps.fetch, id, "drive");
    if ("id" in res) imported.push(res);
    else if (res.error === "reconnect") {
      // The grant ended between the Picker and the import: connect again.
      if (!imported.length) return toConsent(deps, page);
      failed.push(res.error);
    } else failed.push(res.error);
  }
  return { kind: "done", imported, failed };
}

/** One import; `error` is the route's word, or `reconnect` for any 409. */
async function importOne(
  f: Fetch,
  docId: string,
  via: "drive" | "link",
): Promise<Imported | { error: string }> {
  try {
    const res = await post(
      f,
      "/api/read/gdoc",
      via === "drive" ? { url: gdocUrlOf(docId), via } : { url: gdocUrlOf(docId) },
    );
    const j = (await res.json().catch(() => null)) as {
      id?: string;
      title?: string;
      error?: string;
    } | null;
    if (res.ok && j?.id) return { id: j.id, title: j.title ?? "" };
    if (res.status === 409) return { error: "reconnect" };
    return { error: j?.error ?? "fetch-failed" };
  } catch {
    return { error: "fetch-failed" };
  }
}

export type ResyncOutcome = { ok: true; id: string } | { ok: false; error: string };

/**
 * Re-import one imported doc (the "Sync again" on /connections). Through
 * Drive first; a doc that came by its public link was never picked, so
 * Drive does not reach it (`not-granted`, or no connection at all) — then the
 * public link. The book is updated in place either way and its sentence
 * cards follow the changed text (carrySentenceCards on the server).
 */
export async function resyncGdoc(f: Fetch, docId: string): Promise<ResyncOutcome> {
  const d = await importOne(f, docId, "drive");
  if ("id" in d) return { ok: true, id: d.id };
  if (d.error !== "not-granted" && d.error !== "reconnect" && d.error !== "Not found")
    return { ok: false, error: d.error };
  const l = await importOne(f, docId, "link");
  if ("id" in l) return { ok: true, id: l.id };
  // Private and not reachable through Drive: connecting again, or picking it
  // again, grants it.
  if (l.error !== "not-shared") return { ok: false, error: l.error };
  return { ok: false, error: d.error === "reconnect" ? "reconnect" : "not-granted" };
}
