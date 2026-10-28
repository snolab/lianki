/**
 * Word-list catalogs (public/words/*.json, public/alphabets/*.json) cached in
 * IndexedDB (`catalogs` store, see lib/words/idb.ts): a list opens from the
 * local copy at once, and the network copy refreshes it in the background
 * (stale-while-revalidate). Offline, the local copy is all there is.
 *
 * Any IndexedDB failure (private mode, quota, old browser) falls back to the
 * network, so caching can only make things faster, never break them.
 */
import { idbGet, idbPut } from "./idb";

type Cached<T> = { path: string; body: T; savedAt: number };

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  return (await r.json()) as T;
}

async function save<T>(path: string, body: T) {
  try {
    await idbPut("catalogs", { path, body, savedAt: Date.now() } satisfies Cached<T>);
  } catch {}
}

/**
 * A catalog file's JSON: the cached copy if there is one (refreshed in the
 * background), else the network copy (then cached).
 */
export async function loadCatalog<T>(path: string): Promise<T> {
  let cached: Cached<T> | undefined;
  try {
    cached = await idbGet<Cached<T>>("catalogs", path);
  } catch {
    cached = undefined;
  }
  const fresh = fetchJson<T>(path).then(async (body) => {
    await save(path, body);
    return body;
  });
  if (cached) {
    fresh.catch(() => {}); // offline or failed: the cached copy stands
    return cached.body;
  }
  return fresh;
}

/** Fetch a catalog from the network and store it (for "download for offline"). */
export async function downloadCatalog<T>(path: string): Promise<T> {
  const body = await fetchJson<T>(path);
  await save(path, body);
  return body;
}
