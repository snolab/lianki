/**
 * The chat input's + menu (docs/dev-debug-widget.md, "The + menu"): add
 * something to Lianki, or attach something to the message being typed.
 *
 * - **Attach kinds** are a registry (ATTACH_KINDS): each kind is its own
 *   entry, so a later change adds one (file upload, media) without touching
 *   the others. Only "selection" works now; the rest show as "coming soon".
 * - **Add items** come from the host (the app's Create actions, which the
 *   bottom island's ＋ used to hold): the widget never imports the app.
 * - **The page selection** is remembered here (createSelectionMemory): the
 *   last non-empty selection made outside the chat. A phone clears the
 *   page's selection the moment the chat input takes focus, so it cannot be
 *   read at send time.
 */
import { type ChatContext, MAX_SELECTION, cleanContext } from "./wire";

/** One attach kind in the + menu's "Attach to message" group. */
export type AttachKind = {
  id: "selection" | "file" | "media";
  /** Its label's key in ChatStrings. */
  label: "attachSelection" | "attachFile" | "attachMedia";
  /** Not built yet: shown disabled, tagged "coming soon"; no fake behaviour. */
  soon?: true;
};
/**
 * The kinds, in menu order. URL import is not here: the Add group's
 * "Add a link as a card" (the app's create:link) already imports a URL.
 */
export const ATTACH_KINDS: readonly AttachKind[] = [
  { id: "selection", label: "attachSelection" },
  { id: "file", label: "attachFile", soon: true },
  { id: "media", label: "attachMedia", soon: true },
];

/**
 * One row in the + menu's "Add" group, given by the app (the bottom island
 * registers its Create actions with setAddItems). Plain data and a callback,
 * no React element: a hot-loaded widget may run its own copy of React.
 */
export type AddItem = {
  id: string;
  /** Localized by the app. */
  title: string;
  /** An icon of this package's set (icons.tsx); else a plus. */
  icon?: string;
  onPick: () => void;
};

/** The app's add items, on globalThis so every copy of the widget sees them. */
export const ADD_ITEMS_EVENT = "lk:chat-add-items";
const ADD = "__lkChatAddItems";
const NO_ITEMS: readonly AddItem[] = [];
export function addItems(): readonly AddItem[] {
  return ((globalThis as unknown as Record<string, readonly AddItem[] | undefined>)[ADD] ??
    NO_ITEMS) as readonly AddItem[];
}
/** Register (or, with [], withdraw) the app's add items. */
export function setAddItems(items: readonly AddItem[]): void {
  (globalThis as unknown as Record<string, readonly AddItem[]>)[ADD] = items.length
    ? items
    : NO_ITEMS;
  try {
    globalThis.dispatchEvent?.(new Event(ADD_ITEMS_EVENT));
  } catch {}
}

/**
 * Whether a chat input with a + menu is on the page right now: the bottom
 * island drops its own ＋ then (its items are in the chat's menu). Event-driven:
 * the + button announces itself on mount and unmount (CHAT_ATTACH_EVENT).
 */
export const CHAT_ATTACH_EVENT = "lk:chat-attach";
const COUNT = "__lkChatAttach";
type G = Record<string, number | undefined>;
export function chatAttachShown(): boolean {
  return ((globalThis as unknown as G)[COUNT] ?? 0) > 0;
}
/** Mount: +1 and tell; the returned function undoes it. */
export function announceChatAttach(): () => void {
  const g = globalThis as unknown as G;
  const tell = () => {
    try {
      globalThis.dispatchEvent?.(new Event(CHAT_ATTACH_EVENT));
    } catch {}
  };
  g[COUNT] = (g[COUNT] ?? 0) + 1;
  tell();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    g[COUNT] = Math.max(0, (g[COUNT] ?? 1) - 1);
    tell();
  };
}

/** How long a remembered selection stays attachable. */
export const SELECTION_TTL_MS = 30 * 60_000;

/** A remembered selection: what can be attached, and when it was made. */
export type PageSelection = ChatContext & { at: number };

/** The slice of an element read here (the DOM's, or a test's fake). */
export type ElLike = {
  tagName?: string;
  type?: string;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
  parentElement?: ElLike | null;
  nodeType?: number;
};

/** The chat's own elements: its box and an embed's shadow host. */
export const CHAT_FENCE = "[data-debug-chat], [data-lk-chat-host]";

/** Marks a part of a page whose text is never captured (any page may use it). */
export const SENSITIVE = "[data-sensitive], [data-lk-sensitive]";
const SENSITIVE_AUTOCOMPLETE = /password|one-time-code|cc-|csc/i;

/** A field (or a part of the page) whose text must never be attached. */
export function isSensitive(el: ElLike | null | undefined): boolean {
  if (!el) return false;
  if (el.tagName === "INPUT") {
    if ((el.type ?? "").toLowerCase() === "password") return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute?.("autocomplete") ?? "")) return true;
  }
  return !!el.closest?.(SENSITIVE);
}

/** A text node's element (or the node itself when it is one). */
const elementOf = (n: ElLike | null | undefined): ElLike | null =>
  !n ? null : n.nodeType === 1 ? n : (n.parentElement ?? null);

export type SelectionDoc = {
  activeElement: ElLike | null;
  getSelection(): {
    rangeCount: number;
    isCollapsed: boolean;
    anchorNode: ElLike | null;
    focusNode: ElLike | null;
    toString(): string;
    getRangeAt?(i: number): { intersectsNode(n: unknown): boolean };
  } | null;
  /** The excluded elements a selection must not cross (the DOM's). */
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, f: (e: { target: unknown }) => void, capture?: boolean): void;
  removeEventListener(type: string, f: (e: { target: unknown }) => void, capture?: boolean): void;
};

export type SelectionDeps = {
  doc: SelectionDoc;
  /** Whether a node is part of the chat itself (its box, or its shadow host). */
  inChat(node: unknown): boolean;
  /** Where the page is: path (no query), title, host (only off lianki.com). */
  where(): Omit<ChatContext, "selection">;
  now?: () => number;
};

/** What is selected now, outside the chat; "" when nothing; null when it must be left alone. */
export function readSelection(d: Pick<SelectionDeps, "doc" | "inChat">): string | null {
  const a = d.doc.activeElement;
  // A selection inside a text field outside the chat: from its value.
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !d.inChat(a)) {
    if (isSensitive(a)) return null;
    const s = a.selectionStart ?? 0;
    const e = a.selectionEnd ?? 0;
    if (e > s) return (a.value ?? "").slice(s, e);
  }
  const sel = d.doc.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return "";
  if (d.inChat(sel.anchorNode) || d.inChat(sel.focusNode)) return null;
  if (isSensitive(elementOf(sel.anchorNode)) || isSensitive(elementOf(sel.focusNode))) return null;
  // Nor anything it spans: a selection from before a sensitive part (or the
  // chat) to after it would carry that text in toString().
  const fenced = d.doc.querySelectorAll?.(`${SENSITIVE}, ${CHAT_FENCE}`);
  if (fenced?.length && sel.getRangeAt)
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      for (let j = 0; j < fenced.length; j++) if (r.intersectsNode(fenced[j])) return null;
    }
  return sel.toString();
}

/**
 * The last non-empty selection made outside the chat, kept while he goes to
 * the chat input. Cleared when he taps elsewhere on the page (an empty
 * selection after a press outside the chat), by clear() (the chip's ×, a
 * send), and when it is older than SELECTION_TTL_MS.
 */
export function createSelectionMemory(d: SelectionDeps) {
  const now = d.now ?? Date.now;
  let kept: PageSelection | null = null;
  /** Where the last press landed: in the chat (its input, the + button) or on the page. */
  let downInChat = false;
  const subs = new Set<() => void>();
  const set = (v: PageSelection | null) => {
    if (v === kept || (v && kept && v.selection === kept.selection && v.path === kept.path))
      return;
    kept = v;
    for (const f of subs) f();
  };
  const onDown = (e: { target: unknown }) => {
    downInChat = d.inChat(e.target);
  };
  const onChange = () => {
    const text = readSelection(d);
    if (text === null) return;
    const trimmed = text.trim();
    if (trimmed) {
      const ctx = cleanContext({ ...d.where(), selection: trimmed.slice(0, MAX_SELECTION) });
      if (ctx) set({ ...ctx, at: now() });
      return;
    }
    // Empty: the chat taking the focus (or a press in it) keeps what was
    // selected; a press anywhere else on the page lets it go.
    if (downInChat || d.inChat(d.doc.activeElement)) return;
    set(null);
  };
  return {
    start() {
      d.doc.addEventListener("pointerdown", onDown, true);
      d.doc.addEventListener("selectionchange", onChange);
      return () => {
        d.doc.removeEventListener("pointerdown", onDown, true);
        d.doc.removeEventListener("selectionchange", onChange);
      };
    },
    /** The kept selection, while it is fresh. */
    get(): PageSelection | null {
      return kept && now() - kept.at <= SELECTION_TTL_MS ? kept : null;
    },
    clear: () => set(null),
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    /** For tests: run the handlers as the DOM would. */
    _events: { onDown, onChange },
  };
}

/** One line of a selection for the chip: whitespace collapsed. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
