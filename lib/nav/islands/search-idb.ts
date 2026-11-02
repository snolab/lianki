"use client";

/**
 * The nav search index in IndexedDB ("lianki-search"; docs/bottom-nav.md,
 * "Search"). Built from the offline copy: the word lists and the catalogs
 * /words already cached (lianki-words), plus the learner's own cards, study
 * plan and (owner) state tree, downloaded whole now and then. Queries are
 * matched here, on the device, and never sent anywhere.
 *
 * Incremental: each source carries a stamp (a hash of what it was built
 * from); a sync rebuilds only the sources whose stamp changed and drops those
 * that are gone. Syncs run when the palette opens and when the tab comes back
 * (event-driven); remote sources are refreshed at most every REMOTE_MS.
 */
import { idbGet } from "@/lib/words/idb";
import { parseTree } from "@lianki/debug-chat/state-tree";
import {
  type ListLike,
  type SearchDoc,
  cardDocs,
  isGroupList,
  listDocs,
  planDocs,
  stampOf,
  treeDocs,
  wordDocs,
} from "../search-docs";

const DB = "lianki-search";
const VERSION = 1;
/** Fired on window after the index changed. */
export const INDEX_EVENT = "lk:search-index";
const REMOTE_MS = 10 * 60_000;

type Meta = { src: string; stamp: string; at: number; capped?: boolean };

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("docs"))
        db.createObjectStore("docs", { keyPath: "id" }).createIndex("src", "src");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "src" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      dbp = null;
      reject(r.error);
    };
  });
  return dbp;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const txDone = (tx: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });

async function metas(): Promise<Map<string, Meta>> {
  const db = await open();
  const all = await req(db.transaction("meta").objectStore("meta").getAll() as IDBRequest<Meta[]>);
  return new Map(all.map((m) => [m.src, m]));
}

/** Replace one source's documents (or drop it, with `docs` null). */
async function put(src: string, docs: SearchDoc[] | null, meta: Omit<Meta, "src"> | null) {
  const db = await open();
  const tx = db.transaction(["docs", "meta"], "readwrite");
  const store = tx.objectStore("docs");
  const keys = await req(store.index("src").getAllKeys(IDBKeyRange.only(src)));
  for (const k of keys) store.delete(k);
  for (const d of docs ?? []) store.put(d);
  if (meta) tx.objectStore("meta").put({ src, ...meta });
  else tx.objectStore("meta").delete(src);
  await txDone(tx);
}

type Cached<T> = { body: T; savedAt: number };
type CatalogMeta = { id: string; file: string; path?: string };

let running: Promise<boolean> | null = null;

/**
 * Bring the index up to date. Resolves true when anything changed (and
 * INDEX_EVENT fired). One sync at a time; a second call joins the first.
 */
export function syncIndex(o: {
  signedIn: boolean;
  debug: boolean;
  all?: boolean;
  listsLabel: string;
}): Promise<boolean> {
  running ??= doSync(o)
    .catch(() => false)
    .finally(() => {
      running = null;
    });
  return running;
}

async function doSync(o: {
  signedIn: boolean;
  debug: boolean;
  all?: boolean;
  listsLabel: string;
}): Promise<boolean> {
  const have = await metas();
  const seen = new Set<string>();
  let changed = false;
  const now = Date.now();
  const set = async (
    src: string,
    stamp: string,
    build: () => SearchDoc[] | { docs: SearchDoc[]; capped: boolean },
  ) => {
    seen.add(src);
    if (have.get(src)?.stamp === stamp) return;
    const b = build();
    const { docs, capped } = Array.isArray(b) ? { docs: b, capped: false } : b;
    await put(src, docs, { stamp, at: now, capped });
    changed = true;
  };

  // Lists and their words, from the /words offline copy.
  const lists = ((await idbGet<ListLike[]>("lists", "all").catch(() => undefined)) ?? []).filter(
    (l) => !isGroupList(l),
  );
  const [wIdx, aIdx] = await Promise.all([
    idbGet<Cached<{ lists?: CatalogMeta[] }>>("catalogs", "/words/index.json").catch(
      () => undefined,
    ),
    idbGet<Cached<{ lists?: CatalogMeta[] }>>("catalogs", "/alphabets/index.json").catch(
      () => undefined,
    ),
  ]);
  const alphabetIds = new Set((aIdx?.body.lists ?? []).map((c) => c.id));
  await set("lists", stampOf(JSON.stringify(lists.map((l) => [l.id, l.name, l.source]))), () =>
    listDocs(lists, alphabetIds, o.listsLabel),
  );
  for (const l of lists) {
    const w = wIdx?.body.lists?.find((c) => c.id === l.source);
    const a = aIdx?.body.lists?.find((c) => c.id === l.source);
    const path = w
      ? (w.path ?? `/words/${w.file}`)
      : a
        ? (a.path ?? `/alphabets/${a.file}`)
        : l.source?.startsWith("anki:")
          ? `/api/words/lists/${l.id}/entries`
          : null;
    if (!path) continue;
    const src = `words:${l.id}`;
    const cached = await idbGet<Cached<{ entries?: unknown[] }>>("catalogs", path).catch(
      () => undefined,
    );
    if (!cached?.body.entries) {
      seen.add(src); // not downloaded (yet): keep whatever was indexed
      continue;
    }
    const all = !!o.all || !!have.get(src)?.stamp.endsWith(":all");
    await set(src, `${cached.savedAt}:${l.name}${all ? ":all" : ""}`, () =>
      wordDocs(l, cached.body.entries as Parameters<typeof wordDocs>[1], alphabetIds, all),
    );
  }

  // Remote sources: his own data, downloaded whole (never a query), now and then.
  const fresh = (src: string) => {
    const m = have.get(src);
    if (m && now - m.at < REMOTE_MS) {
      seen.add(src);
      return true;
    }
    return false;
  };
  const json = async <T>(url: string): Promise<T | null> => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  if (o.signedIn && navigator.onLine) {
    if (!fresh("cards")) {
      const rows: { url: string; title?: string }[] = [];
      for (let page = 0; page < 10; page++) {
        const d = await json<{ rows?: { url: string; title?: string }[]; total?: number }>(
          `/api/fsrs/list?size=200&page=${page}&sort=due&order=asc&due=all`,
        );
        if (!d?.rows) break;
        rows.push(...d.rows);
        if (d.rows.length < 200 || rows.length >= (d.total ?? 0)) break;
      }
      await set("cards", stampOf(JSON.stringify(rows.map((r) => [r.url, r.title]))), () =>
        cardDocs(rows),
      );
    }
    if (!fresh("plan")) {
      const goals = await json<unknown[]>("/api/roadmap");
      if (goals)
        await set("plan", stampOf(JSON.stringify(goals)), () =>
          planDocs(goals as Parameters<typeof planDocs>[0]),
        );
      else seen.add("plan");
    }
  } else {
    for (const s of ["cards", "plan"]) if (have.has(s)) seen.add(s);
  }
  if (o.debug && navigator.onLine && !fresh("tree")) {
    try {
      const r = await fetch("/api/dev/state-tree", { cache: "no-store" });
      const md = r.ok ? await r.text() : "";
      if (md) await set("tree", stampOf(md), () => treeDocs(parseTree(md)));
      else if (have.has("tree")) seen.add("tree");
    } catch {
      if (have.has("tree")) seen.add("tree");
    }
  } else if (o.debug && have.has("tree")) seen.add("tree");

  // Sources that are gone: a deleted list, debug mode off.
  for (const src of have.keys())
    if (!seen.has(src)) {
      await put(src, null, null);
      changed = true;
    }
  if (changed) {
    docsCache = null;
    window.dispatchEvent(new Event(INDEX_EVENT));
  }
  return changed;
}

let docsCache: Promise<{ docs: Map<string, SearchDoc[]>; capped: boolean }> | null = null;

/** Every indexed document by kind, held in memory until the index changes. */
export function loadDocs(): Promise<{ docs: Map<string, SearchDoc[]>; capped: boolean }> {
  docsCache ??= (async () => {
    const db = await open();
    const tx = db.transaction(["docs", "meta"]);
    const [all, ms] = await Promise.all([
      req(tx.objectStore("docs").getAll() as IDBRequest<SearchDoc[]>),
      req(tx.objectStore("meta").getAll() as IDBRequest<Meta[]>),
    ]);
    const docs = new Map<string, SearchDoc[]>();
    for (const d of all) {
      const a = docs.get(d.kind);
      if (a) a.push(d);
      else docs.set(d.kind, [d]);
    }
    return { docs, capped: ms.some((m) => m.capped) };
  })().catch(() => {
    docsCache = null;
    return { docs: new Map(), capped: false };
  });
  return docsCache;
}

/**
 * Open a word at the top of its list: /words restores the reader's place from
 * its UI store (`lk:ui:words` anchors, app/(app)/words/ui-store.ts), keyed by
 * the list and holding `${listId}\0${term}`.
 */
export function anchorWord(listId: string, term: string) {
  const key = "lk:ui:words";
  const value = `${listId}\u0000${term}`;
  const live = (
    globalThis as {
      __lkUiStores?: Map<
        string,
        { getState: () => { anchors?: Record<string, string> }; setState: (s: object) => void }
      >;
    }
  ).__lkUiStores?.get(key);
  if (live) {
    live.setState({ anchors: { ...live.getState().anchors, [listId]: value } });
    return;
  }
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
      state?: { anchors?: Record<string, string> };
      version?: number;
    } | null;
    const state = { ...raw?.state, anchors: { ...raw?.state?.anchors, [listId]: value } };
    sessionStorage.setItem(key, JSON.stringify({ state, version: raw?.version ?? 1 }));
  } catch {}
}
