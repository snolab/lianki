/**
 * The chat's session UI state, on the shared UI-state factory
 * (`@lianki/ui-state`, docs/ui-state.md): a zustand store with `persist` over
 * sessionStorage (key `lk:ui:chat`), one instance per page on globalThis, so
 * a refresh, a hot swap of the widget, or the built-in chat taking over all
 * see the same state. Storage never throws (the factory falls back to
 * memory).
 *
 * UI state only: what was being typed, whether the tree is open, the tree's
 * place. Never business data (messages, cards, grants, tokens). Device
 * preferences (speech rate, voice-out mode, the bar's remembered position)
 * stay in localStorage, where they already live.
 */
import { createUiStore } from "@lianki/ui-state";
import type { KeptTree } from "./tree-keep";

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
  /** Per agent message id: how many of its sentences were read aloud (read-progress.ts). */
  spoken: Record<string, number>;
  /** Replies still being read when the page went away: resumed after a reload (read-progress.ts). */
  reading: { id: string; from: number; at: number }[];
  // Not kept: the log's scroll (at rest the compact log always shows the
  // newest lines), the bar's position (localStorage, remembered across
  // sessions), the full-screen log (only during a drag) and the mic (it
  // needs the owner's gesture; it never turns itself on after a reload).
};
export const CHAT_UI_NAME = "chat";
export const CHAT_UI_VERSION = 1;
export const CHAT_UI_INITIAL: ChatUi = {
  draft: "",
  caret: null,
  pureDictation: null,
  panel: "none",
  tree: null,
  spoken: {},
  reading: [],
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
  const spoken: Record<string, number> = {};
  if (p.spoken && typeof p.spoken === "object" && !Array.isArray(p.spoken))
    for (const [id, n] of Object.entries(p.spoken as Record<string, unknown>).slice(-200))
      if (id.length <= 100 && typeof n === "number" && Number.isInteger(n) && n > 0)
        spoken[id] = Math.min(n, 1000);
  const reading: ChatUi["reading"] = [];
  if (Array.isArray(p.reading))
    for (const r of p.reading.slice(0, 20)) {
      const x = r as Record<string, unknown>;
      if (
        x &&
        typeof x.id === "string" &&
        x.id.length <= 100 &&
        Number.isInteger(x.from) &&
        (x.from as number) >= 0 &&
        typeof x.at === "number" &&
        Number.isFinite(x.at)
      )
        reading.push({ id: x.id, from: x.from as number, at: x.at });
    }
  return { draft, caret, pureDictation, panel, tree: migrateTree(p.tree), spoken, reading };
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

/** The chat's UI store (one per page, shared by hot-swapped widget copies). */
export const chatUi = () =>
  createUiStore<ChatUi>(CHAT_UI_NAME, CHAT_UI_VERSION, CHAT_UI_INITIAL, {
    storage: "session",
    // Every stored value goes through the same checks, whatever its version.
    clean: (v) => migrateChatUi(v, CHAT_UI_VERSION),
    migrate: (v, from) => migrateChatUi(v, from),
  });
