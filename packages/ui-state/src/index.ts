/**
 * UI-state stores (docs/ui-state.md): one small zustand store per concern,
 * persisted where it belongs.
 *
 *   const words = createUiStore("words", 1, { listId: null, settingsOpen: false }, { storage: "session" });
 *   const open = useUi(words, (s) => s.settingsOpen);
 *   words.setState({ settingsOpen: true });
 *
 * - "session": sessionStorage, key `lk:ui:<name>`. This tab only; survives a
 *   refresh and a hot island swap, gone with the tab. UI state only (panels,
 *   positions, drafts, the current selection) — never cards, grades, queues.
 * - "local": localStorage, key `lk:pref:<name>`. A device preference that
 *   outlives the tab (theme, voice rate, a feel preset); other tabs follow
 *   through the `storage` event.
 * - "account": stored exactly as "local" (`lk:pref:<name>`, the device's copy,
 *   read for the first paint), and kept in step with the account by the sync
 *   engine (./account.ts, docs/prefs-sync.md). Each write tells the engine
 *   (`lk:pref-write`); the app says which fields go to the server.
 *
 * Every store is one instance per page, kept on globalThis by its key: a
 * hot-swapped island (or the hot-loaded chat widget) that creates "the same"
 * store gets the page's instance, with its state. A different version of the
 * same store throws, so an island built against another shape falls back
 * instead of corrupting it.
 *
 * Storage never throws (private mode, quota, sandboxed iframes): it falls
 * back to memory. Stored values are cleaned against the initial state's
 * shape; an older version is migrated, else dropped. On the server nothing is
 * read; `useUi` renders the initial state first and the stored one after
 * hydration, so server and client agree.
 *
 * No imports from the app: the chat widget (packages/debug-chat) uses it too.
 */
import { useSyncExternalStore } from "react";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import { notePrefWrite } from "./account";

export {
  notePrefWrite,
  notePrefApplied,
  PREF_APPLIED_EVENT,
  PREF_WRITE_EVENT,
} from "./account";

export type UiStorage = "session" | "local" | "account";

export type UiStoreOptions<T> = {
  storage: UiStorage;
  /** What an older version stored, turned into this version's state. Without it, old state is dropped. */
  migrate?: (stored: unknown, fromVersion: number) => Partial<T>;
  /** Check a stored value; the default keeps only keys of the initial state with the same type. */
  clean?: (stored: unknown) => Partial<T>;
  /** Only these keys are stored; the rest live in memory for the page. Default: all. */
  keys?: readonly (keyof T)[];
};

export type UiStore<T> = StoreApi<T> & {
  readonly key: string;
  readonly version: number;
  readonly initial: T;
  readonly storage: UiStorage;
};

/** `lk:ui:<name>` (session) or `lk:pref:<name>` (local, account). */
export const uiKey = (name: string, storage: UiStorage) =>
  `lk:${storage === "session" ? "ui" : "pref"}:${name}`;

/** Where stores live, one per key, for the whole page. */
export const REGISTRY = "__lkUiStores";

function registry(): Map<string, UiStore<unknown>> {
  const g = globalThis as unknown as Record<string, Map<string, UiStore<unknown>>>;
  return (g[REGISTRY] ??= new Map());
}

/** sessionStorage / localStorage that never throws; memory when it can't be used. */
export function safeStorage(kind: UiStorage, memory = new Map<string, string>()): StateStorage {
  const real = (): Storage | null => {
    try {
      if (typeof window === "undefined") return null;
      return kind === "session" ? window.sessionStorage : window.localStorage; // local, account
    } catch {
      return null;
    }
  };
  return {
    getItem: (k) => {
      try {
        const s = real();
        if (s) return s.getItem(k);
      } catch {}
      return memory.get(k) ?? null;
    },
    setItem: (k, v) => {
      try {
        const s = real();
        if (s) return void s.setItem(k, v);
      } catch {}
      memory.set(k, v);
    },
    removeItem: (k) => {
      try {
        real()?.removeItem(k);
      } catch {}
      memory.delete(k);
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Keys of `initial` whose stored value has the same type (null matches null or an object). */
export function cleanByShape<T extends object>(initial: T, stored: unknown): Partial<T> {
  if (!isObj(stored)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v0] of Object.entries(initial)) {
    if (!(k in stored)) continue;
    const v = stored[k];
    const same =
      v0 === null
        ? v !== undefined
        : Array.isArray(v0)
          ? Array.isArray(v)
          : typeof v0 === "object"
            ? isObj(v)
            : typeof v === typeof v0;
    if (same) out[k] = v;
  }
  return out as Partial<T>;
}

export function createUiStore<T extends object>(
  name: string,
  version: number,
  initial: T,
  opts: UiStoreOptions<T>,
): UiStore<T> {
  const key = uiKey(name, opts.storage);
  const browser = typeof window !== "undefined";
  if (browser) {
    const have = registry().get(key);
    if (have) {
      if (have.version !== version)
        throw new Error(`ui-state ${key}: the page has v${have.version}, this code wants v${version}`);
      return have as UiStore<T>;
    }
  }
  const clean = (v: unknown) => (opts.clean ? opts.clean(v) : cleanByShape(initial, v));
  const store = createStore<T>()(
    persist(() => initial, {
      name: key,
      version,
      storage: createJSONStorage(() => safeStorage(opts.storage)),
      partialize: (s) =>
        (opts.keys
          ? Object.fromEntries(opts.keys.map((k) => [k, s[k]]))
          : s) as unknown as T,
      migrate: (stored, from) => (opts.migrate ? opts.migrate(stored, from) : {}) as T,
      merge: (stored, current) => ({ ...current, ...clean(stored) }),
    }),
  );
  const ui = Object.assign(store, { key, version, initial, storage: opts.storage }) as UiStore<T>;
  if (browser) {
    registry().set(key, ui as UiStore<unknown>);
    // A preference changed in another tab (or applied from the account): follow it.
    if (opts.storage !== "session")
      window.addEventListener("storage", (e) => {
        if (e.key === key) void (store as unknown as { persist: { rehydrate: () => void } }).persist.rehydrate();
      });
    // Tell the account sync engine, which compares and pushes what changed.
    if (opts.storage === "account") store.subscribe(() => notePrefWrite());
  }
  return ui;
}

/**
 * A slice of a store, for React. The server and the hydrating render see the
 * initial state; the stored one follows. The selector must return a stable
 * value (a primitive, or a reference held in the state), not a new object.
 */
export function useUi<T, S>(store: UiStore<T>, select: (s: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.initial),
  );
}

/** Drop every store (tests only). */
export function resetUiStores() {
  registry().clear();
}
