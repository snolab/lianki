/**
 * UI state that survives a refresh and a hot swap of the widget: a zustand
 * store with `persist` over sessionStorage. Session-scoped UI state only
 * (what was being typed, which panel was open, where the log was scrolled),
 * never business data: messages, cards, grants and tokens keep their own
 * sources. Device preferences (speech rate, voice-out mode, the bar's
 * remembered position) stay in localStorage, where they already live.
 *
 * `createUiStore(name, version, initial, opts)` follows the convention of
 * the shared factory (`@lianki/ui-state`, PR #333, docs/ui-state.md: zustand
 * persist, one instance per page on globalThis.__lkUiStores, migrate +
 * clean on rehydrate). It is not imported from there yet only because #333
 * is not on main; once it is, `chatUi()` becomes
 * `createUiStore("chat", 1, CHAT_UI_INITIAL, { storage: "session", migrate, clean })`
 * (key `lk:ui:chat`). Same zustand version (5.0.15). Like it:
 * one store per name per page, kept on globalThis, so a re-imported widget
 * module (a hot reload, or the fallback to the built-in chat) gets the same
 * store rather than a fresh one.
 *
 * Only `zustand/vanilla` and `zustand/middleware` are used here (no React);
 * components read the store with `useStore` from "zustand", whose `react`
 * import the widget build maps to the page's React like every other one.
 */
import { type StateStorage, createJSONStorage, persist } from "zustand/middleware";
import { type StoreApi, createStore } from "zustand/vanilla";
import { type KeyStore, getKey, removeKey, setKey } from "./storage-keys";
import type { KeptTree } from "./tree-keep";

/** sessionStorage, or null where it is missing or its accessor throws. */
export const session = (): KeyStore | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

/**
 * A StateStorage over a KeyStore by the storage-keys rules (the `lk:agent-…`
 * name read first, written with its legacy twin), every access in try/catch.
 */
export function keyStorage(store: () => KeyStore | null = session): StateStorage {
  return {
    getItem: (name) => getKey(name, store()),
    setItem: (name, value) => setKey(name, value, store()),
    removeItem: (name) => removeKey(name, store()),
  };
}

/**
 * Writes coalesced: the latest value per name goes out `ms` after the last
 * change (a keystroke writes nothing by itself), and at once on `flush()`,
 * which the page calls when it is hidden or unloaded. Reads see a pending
 * value, so nothing reads back stale.
 */
export function debouncedStorage(
  base: StateStorage,
  ms: number,
  // Wrapped: a bare `timers.set(…)` would call the browser's setTimeout with
  // `this` = timers, which throws "Illegal invocation".
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = {
    set: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
    clear: ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as typeof clearTimeout,
  },
): StateStorage & { flush(): void } {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    for (const [name, value] of pending) void base.setItem(name, value);
    pending.clear();
  };
  return {
    getItem: (name) => pending.get(name) ?? base.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value);
      if (timer !== undefined) timers.clear(timer);
      timer = timers.set(flush, ms);
    },
    removeItem: (name) => {
      pending.delete(name);
      void base.removeItem(name);
    },
    flush,
  };
}

type UiStores = Map<string, StoreApi<unknown>>;
const STORES = "__lkUiStores";
const registry = (): UiStores => {
  const g = globalThis as { [STORES]?: UiStores };
  g[STORES] ??= new Map();
  return g[STORES];
};

/**
 * A persisted UI store, one per `name` per page. `migrate` turns whatever an
 * older version (or a damaged entry) left into a valid state; it also runs on
 * every rehydration, so a hand-edited or truncated entry cannot break the UI.
 */
export function createUiStore<T extends object>(
  name: string,
  version: number,
  initial: T,
  opts: { storage?: StateStorage; migrate: (persisted: unknown, version: number) => T },
): StoreApi<T> {
  const have = registry().get(name);
  if (have) return have as StoreApi<T>;
  const store = createStore<T>()(
    persist(() => initial, {
      name,
      version,
      storage: createJSONStorage(() => opts.storage ?? keyStorage()),
      migrate: (p, v) => opts.migrate(p, v),
      merge: (p, current) => ({ ...current, ...opts.migrate(p, version) }),
    }),
  );
  registry().set(name, store as StoreApi<unknown>);
  return store;
}

/** The chat's session UI state. */
export type ChatUi = {
  /** The input's draft, and the caret in it (null: the end). */
  draft: string;
  caret: number | null;
  /** The draft as dictation left it (wire.ts dictatedDraft): a restored voice line still sends as `stt`. */
  pureDictation: string | null;
  /** The panel over the log. The menu is never restored, only the tree. */
  panel: "none" | "tree";
  /**
   * The state tree (his study plan included): the focused node, which nodes
   * are open and how deep, and the minimized tree's scroll. By title paths
   * (TreeChips.tsx keepTree / restoreTree): a node that is gone falls back to
   * its nearest ancestor.
   */
  tree: KeptTree | null;
  // Not kept: the log's scroll (at rest the compact log always shows the
  // newest lines), the bar's position (localStorage, remembered across
  // sessions), the full-screen log (only during a drag) and the mic (it
  // needs the owner's gesture; it never turns itself on after a reload).
};
export const CHAT_UI_NAME = "lk:debug-chat-ui";
export const CHAT_UI_VERSION = 1;
export const CHAT_UI_INITIAL: ChatUi = {
  draft: "",
  caret: null,
  pureDictation: null,
  panel: "none",
  tree: null,
};
/** A draft longer than this is not restored (the input's own cap is lower). */
const MAX_DRAFT = 20_000;

/** Any persisted value (any version) → a valid ChatUi; what is wrong falls back to the default. */
export function migrateChatUi(persisted: unknown, _version: number): ChatUi {
  const p = (persisted && typeof persisted === "object" ? persisted : {}) as Record<string, unknown>;
  const draft = typeof p.draft === "string" && p.draft.length <= MAX_DRAFT ? p.draft : "";
  const caret =
    typeof p.caret === "number" && Number.isInteger(p.caret) && p.caret >= 0
      ? Math.min(p.caret, draft.length)
      : null;
  // Only meaningful while the draft is still exactly the dictation.
  const pureDictation =
    typeof p.pureDictation === "string" && p.pureDictation === draft && draft ? draft : null;
  const panel = p.panel === "tree" ? "tree" : "none";
  return { draft, caret, pureDictation, panel, tree: migrateTree(p.tree) };
}

/** A title path: a short list of short strings. */
const titlePath = (v: unknown): string[] | null =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= 32 &&
  v.every((s) => typeof s === "string" && s.length <= 500)
    ? (v as string[])
    : null;

function migrateTree(v: unknown): KeptTree | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const expanded: [string[], number][] = [];
  if (Array.isArray(t.expanded))
    for (const e of t.expanded.slice(0, 200)) {
      if (!Array.isArray(e)) continue;
      const path = titlePath(e[0]);
      const d = e[1];
      if (path && typeof d === "number" && Number.isInteger(d) && d > 0)
        expanded.push([path, Math.min(d, 3)]);
    }
  const scroll =
    typeof t.scroll === "number" && Number.isFinite(t.scroll) && t.scroll > 0
      ? Math.round(t.scroll)
      : 0;
  return { focus: titlePath(t.focus), expanded, scroll };
}

/** How long typing waits before the draft is written. */
export const CHAT_UI_WRITE_MS = 300;
let chatStorage: ReturnType<typeof debouncedStorage> | null = null;
/** The chat's storage (debounced over sessionStorage), flushed when the page is hidden. */
export function chatUiStorage() {
  if (chatStorage) return chatStorage;
  chatStorage = debouncedStorage(keyStorage(), CHAT_UI_WRITE_MS);
  if (typeof addEventListener !== "undefined") {
    const flush = () => chatStorage?.flush();
    addEventListener("pagehide", flush);
    addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
    });
  }
  return chatStorage;
}

/** The chat's UI store (one per page, shared by hot-swapped widget copies). */
export const chatUi = () =>
  createUiStore<ChatUi>(CHAT_UI_NAME, CHAT_UI_VERSION, CHAT_UI_INITIAL, {
    storage: chatUiStorage(),
    migrate: migrateChatUi,
  });
