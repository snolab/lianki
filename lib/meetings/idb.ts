/**
 * The IndexedDB store of the piece queue (lib/meetings/queue.ts): database
 * `lk-meetings`, object store `pieces`, keyed `<meeting>/<track>/<seq>`.
 * Falls back to memory where IndexedDB is unavailable (a private window).
 */
import { type PieceStore, type QueuedPiece, memoryStore, pieceKey } from "./queue";

const DB = "lk-meetings";
const STORE = "pieces";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = f(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function idbStore(): PieceStore {
  if (typeof indexedDB === "undefined") return memoryStore();
  let db: Promise<IDBDatabase> | null = null;
  const get = () => (db ??= open());
  return {
    async put(p) {
      await tx(await get(), "readwrite", (s) => s.put(p, pieceKey(p)));
    },
    async delete(k) {
      await tx(await get(), "readwrite", (s) => s.delete(k));
    },
    async all() {
      const all = (await tx(await get(), "readonly", (s) => s.getAll())) as QueuedPiece[];
      return all.sort((a, b) => a.at - b.at);
    },
  };
}
