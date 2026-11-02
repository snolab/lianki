/**
 * The word-list IndexedDB ("lianki-words"). Word-list content and learning
 * records live in separate stores:
 *
 *   catalogs  catalog JSON per path (public/words/*, public/alphabets/*)
 *   lists     the last /api/words/lists response
 *   sessions  the last due words per list, with when they were fetched
 *   pending   review / undo ops made offline (or not yet sent), in order
 *
 * v1 had only `catalogs`; the v2 upgrade adds the rest and keeps it.
 */

export const DB_NAME = "lianki-words";
export const DB_VERSION = 2;

export type PendingOp = {
  id?: number;
  listId: string;
  /** `rename` renames the list itself (body `{name}`, term ""). */
  op: "review" | "undo" | "rename";
  /** The JSON body for /api/words/lists/:listId/review, /undo or /rename. */
  body: Record<string, unknown>;
  /** The word it concerns, for undo and for hiding it from cached sessions ("" for a rename). */
  term: string;
  at: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openWordsDb(): Promise<IDBDatabase> {
  if (!dbPromise)
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("catalogs"))
          db.createObjectStore("catalogs", { keyPath: "path" });
        if (!db.objectStoreNames.contains("lists")) db.createObjectStore("lists");
        if (!db.objectStoreNames.contains("sessions"))
          db.createObjectStore("sessions", { keyPath: "listId" });
        if (!db.objectStoreNames.contains("pending"))
          db.createObjectStore("pending", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openWordsDb();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openWordsDb();
  await done(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

export async function idbAll<T>(store: string): Promise<T[]> {
  const db = await openWordsDb();
  return done(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openWordsDb();
  await done(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function idbAdd(store: string, value: unknown): Promise<IDBValidKey> {
  const db = await openWordsDb();
  return done(db.transaction(store, "readwrite").objectStore(store).add(value));
}
