/**
 * The study page's UI state (docs/ui-state.md): this tab only
 * (sessionStorage, `lk:ui:<page>`). It survives a refresh and a hot island
 * swap and goes with the tab. Positions and panels only; cards, grades and
 * the queue are never kept here.
 *
 * One store per page (/words, /alphabets), so their lists and positions
 * don't mix.
 */
import { type UiStore, createUiStore } from "@lianki/ui-state";

export type WordsUi = {
  /** The list open in this tab. The URL's ?list= wins; this fills in when it is absent. */
  listId: string | null;
  settingsOpen: boolean;
  /** The keyboard help strip (?). */
  helpOpen: boolean;
  /**
   * Per list: where the reader was. It is the word at the top of the screen
   * (keyOf: list id + term), a position, not the card. Restored when the
   * queue loads, if that word is still in it.
   */
  anchors: Record<string, string>;
};

const INITIAL: WordsUi = { listId: null, settingsOpen: false, helpOpen: false, anchors: {} };

/** Lists remembered per tab; the oldest anchors go first. */
const MAX_ANCHORS = 20;

export function cleanWordsUi(raw: unknown): Partial<WordsUi> {
  if (!raw || typeof raw !== "object") return {};
  const v = raw as Record<string, unknown>;
  const out: Partial<WordsUi> = {};
  if (v.listId === null || (typeof v.listId === "string" && v.listId.length <= 200))
    out.listId = v.listId;
  if (typeof v.settingsOpen === "boolean") out.settingsOpen = v.settingsOpen;
  if (typeof v.helpOpen === "boolean") out.helpOpen = v.helpOpen;
  if (v.anchors && typeof v.anchors === "object" && !Array.isArray(v.anchors))
    out.anchors = Object.fromEntries(
      Object.entries(v.anchors as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .slice(-MAX_ANCHORS),
    );
  return out;
}

/** This page's store: "words" for /words, "alphabets" for /alphabets. */
export function wordsUiStore(base: string): UiStore<WordsUi> {
  const name = base.replace(/^\/+/, "").replace(/[^\w-]/g, "-") || "words";
  return createUiStore(name, 1, INITIAL, { storage: "session", clean: cleanWordsUi });
}

/** Remember where the reader is in `listId`. */
export function setAnchor(store: UiStore<WordsUi>, listId: string, key: string | null) {
  const { anchors } = store.getState();
  if (key === null ? !(listId in anchors) : anchors[listId] === key) return;
  const next = { ...anchors };
  delete next[listId];
  if (key !== null) next[listId] = key;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ANCHORS))) delete next[k];
  store.setState({ anchors: next });
}

/**
 * The scrollTop that puts the anchored word just under the toolbar, or null
 * when it is gone from the queue (graded since, or another session).
 */
export function anchorTop(
  index: number,
  o: { pad: number; rowH: number; barTop: number; max?: number },
): number | null {
  if (index < 0) return null;
  const top = o.pad + index * o.rowH - o.barTop;
  return Math.max(0, o.max === undefined ? top : Math.min(o.max, top));
}

/** The index of the row at the top of the screen, for a scrollTop. */
export const topIndex = (scrollTop: number, o: { pad: number; rowH: number; barTop: number }) =>
  Math.max(0, Math.floor((scrollTop + o.barTop - o.pad) / o.rowH + 0.5));
