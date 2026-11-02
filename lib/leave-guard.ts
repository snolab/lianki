/**
 * The app-wide guard against leaving unsaved work (docs/ui-state.md, "Unsaved
 * work"), on lib/page-dirty.ts's "leave" answer:
 *
 * - leaving the document (close, reload, a full-page or external link):
 *   `beforeunload`, so the browser shows its own prompt;
 * - a same-origin link (next/link, the locale links, a plain <a>): a click
 *   caught on window in the capture phase — before React's root listener, so
 *   Next.js never starts the navigation — and confirmed;
 * - a tab, a panel, a route pushed by code: the component calls
 *   confirmLeave() (lib/use-leave-guard.ts).
 *
 * Back/forward are not caught: the URL has already changed when `popstate`
 * fires, and undoing it would fight the Next.js router's own history state.
 * The deploy auto-reload never asks: it waits for a clean page (whenClean).
 */
import { setLeaveGuard } from "@lianki/ui-state/dirty";
import { type DocLike, pageIsDirty, trackEdits } from "./page-dirty";

export type ClickLike = {
  target: unknown;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
};
type AnchorLike = {
  getAttribute(name: string): string | null;
  hasAttribute?(name: string): boolean;
};

/**
 * The link a click follows inside this tab, as a URL on this origin that is a
 * different page (not only a #hash) — else null: a new tab, a download, an
 * external site (beforeunload covers those), or no link.
 */
export function inAppLeave(e: ClickLike, here: string): URL | null {
  if (e.defaultPrevented || (e.button ?? 0) !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const t = e.target as { closest?(s: string): AnchorLike | null } | null;
  const a = t?.closest?.("a[href]");
  if (!a) return null;
  const target = a.getAttribute("target");
  if (target && target !== "_self") return null;
  if (a.getAttribute("download") !== null) return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(here);
    to = new URL(a.getAttribute("href") ?? "", from);
  } catch {
    return null;
  }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return to;
}

export type WinLike = {
  location: { href: string };
  addEventListener(type: string, f: (e: never) => void, capture?: boolean): void;
  removeEventListener(type: string, f: (e: never) => void, capture?: boolean): void;
};
type UnloadLike = { preventDefault(): void; returnValue?: unknown };

/** Install the guard; returns its removal. `ask` is the confirm, `now` the clock (tests). */
export function installLeaveGuard(
  win: WinLike,
  doc: DocLike,
  message: string,
  ask: (m: string) => boolean = (m) => globalThis.confirm(m),
  now: () => number = Date.now,
): () => void {
  const dirty = () => pageIsDirty(doc, "leave");
  /** He just said "leave" to a link: the page's own unload must not ask again. */
  let confirmedAt = -Infinity;
  const onClick = (e: ClickLike) => {
    if (!inAppLeave(e, win.location.href) || !dirty()) return;
    if (ask(message)) {
      confirmedAt = now();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onUnload = (e: UnloadLike) => {
    if (now() - confirmedAt < 3000 || !dirty()) return;
    e.preventDefault();
    // Older Chrome and Safari still want returnValue set.
    e.returnValue = "";
  };
  const untrack = trackEdits(doc);
  const unguard = setLeaveGuard({ isDirty: dirty, message });
  win.addEventListener("click", onClick as (e: never) => void, true);
  win.addEventListener("beforeunload", onUnload as (e: never) => void);
  return () => {
    win.removeEventListener("click", onClick as (e: never) => void, true);
    win.removeEventListener("beforeunload", onUnload as (e: never) => void);
    unguard();
    untrack();
  };
}
