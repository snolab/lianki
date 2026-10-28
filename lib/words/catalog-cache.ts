/**
 * Word-list catalogs (public/words/*.json, public/alphabets/*.json) cached in
 * IndexedDB: a list opens from the local copy at once, and the network copy
 * refreshes it in the background (stale-while-revalidate). The same store is
 * what an offline mode will read.
 *
 * Any IndexedDB failure (private mode, quota, old browser) falls back to the
 * network, so caching can only make things faster, never break them.
 */

const DB = "lianki-words";
const STORE = "catalogs";

type Cached<T> = { path: string; body: T; savedAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "path" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function read<T>(path: string): Promise<Cached<T> | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(path);
    req.onsuccess = () => resolve(req.result as Cached<T> | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function write<T>(path: string, body: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ path, body, savedAt: Date.now() } satisfies Cached<T>);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  return (await r.json()) as T;
}

/**
 * A catalog file's JSON: the cached copy if there is one (refreshed in the
 * background), else the network copy (then cached).
 */
export async function loadCatalog<T>(path: string): Promise<T> {
  let cached: Cached<T> | undefined;
  try {
    cached = await read<T>(path);
  } catch {
    cached = undefined;
  }
  const fresh = fetchJson<T>(path).then(async (body) => {
    try {
      await write(path, body);
    } catch {}
    return body;
  });
  if (cached) {
    fresh.catch(() => {}); // offline or failed: the cached copy stands
    return cached.body;
  }
  return fresh;
}
