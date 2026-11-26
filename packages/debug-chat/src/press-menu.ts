/**
 * Press, drag, release menus (owner, 2026-11-27: "按住拖到选项上松手就执行，
 * 像 Windows 菜单一样"; the + menu, the grip's menu, a message's details).
 *
 * A press that opens a menu keeps following the pointer until it lifts:
 * - sliding over an item highlights it (and focuses it, for screen readers);
 * - letting go on an item triggers it (its own click, so it does exactly
 *   what a click does);
 * - letting go elsewhere, after moving, cancels (the menu closes); back on
 *   the opener, or without moving at all, it is a plain tap: the menu stays
 *   open for a separate click, as before;
 * - Escape cancels; a stolen touch (pointercancel) only stops following,
 *   the menu staying open as after a tap.
 *
 * The click the browser sends after the release is swallowed, so nothing
 * underneath (the grip's own tap) acts on it too. No window move ever starts
 * from here: the caller opens menus only on presses that are not drags.
 */

/** What a release can land on in a menu. */
export const PRESS_ITEM = [
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="radio"]',
  "button",
  "a[href]",
]
  .map((s) => `${s}:not([disabled]):not([aria-disabled="true"])`)
  .join(",");

/** Movement under this many px is no slide (a plain tap or right-click). */
export const PRESS_SLOP_PX = 6;

/** The hovered item's highlight: seal red, faint (oklch). */
export const PRESS_HOT_BG = "oklch(0.53 0.207 22.3 / 0.16)";

type Point = { x: number; y: number };

export type PressMenuDeps = {
  /** Where the pointer events and the click arrive (the page's window). */
  win: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout">;
  /** The open menu (it may render a frame after the press). */
  menu: () => HTMLElement | null;
  /** What was pressed to open it (a release back on it is a tap). */
  opener?: () => HTMLElement | null;
  /** The press: where, and which pointer. */
  start: Point & { pointerId?: number };
  /** Close the menu (a cancel). */
  close: () => void;
  slopPx?: number;
};

/** The topmost element at a point, in the menu's own tree (a shadow root for 随身Li). */
function hitAt(menu: HTMLElement, p: Point): Element | null {
  const root = menu.getRootNode() as Document | ShadowRoot;
  const at = (root as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint;
  const el = at ? at.call(root, p.x, p.y) : null;
  return el ?? menu.ownerDocument?.elementFromPoint?.(p.x, p.y) ?? null;
}

/** The item under a point, inside the open menu only. */
export function itemAt(menu: HTMLElement | null, p: Point): HTMLElement | null {
  if (!menu) return null;
  const el = hitAt(menu, p);
  const item = el?.closest?.(PRESS_ITEM) as HTMLElement | null | undefined;
  return item && menu.contains(item) ? item : null;
}

/** What letting go does (pure, for the tests). */
export function releaseAction(d: {
  moved: boolean;
  onItem: boolean;
  onOpener: boolean;
  inMenu: boolean;
}): "trigger" | "keep" | "cancel" {
  // No slide: a plain tap or right-click; the menu stays for a separate click
  // (an item that happens to be under the press is not picked by accident).
  if (!d.moved) return "keep";
  if (d.onItem) return "trigger";
  // Back on the opener, or on the menu's own padding: as a tap, it stays.
  if (d.onOpener || d.inMenu) return "keep";
  return "cancel";
}

/**
 * Follow one press until it lifts. Returns `end` (stop following, nothing
 * else), for when the menu closes some other way first.
 */
export function pressMenu(d: PressMenuDeps): { end: () => void } {
  const slop = d.slopPx ?? PRESS_SLOP_PX;
  let moved = false;
  let hot: HTMLElement | null = null;
  let hotBg = "";
  let done = false;
  const same = (e: PointerEvent) => d.start.pointerId === undefined || e.pointerId === d.start.pointerId;
  const setHot = (el: HTMLElement | null) => {
    if (el === hot) return;
    if (hot) {
      hot.style.backgroundColor = hotBg;
      delete hot.dataset.pressHot;
    }
    hot = el;
    if (el) {
      hotBg = el.style.backgroundColor;
      el.style.backgroundColor = PRESS_HOT_BG;
      el.dataset.pressHot = "";
      el.focus?.({ preventScroll: true });
    }
  };
  const end = () => {
    if (done) return;
    done = true;
    setHot(null);
    d.win.removeEventListener("pointermove", move as EventListener, true);
    d.win.removeEventListener("pointerup", up as EventListener, true);
    d.win.removeEventListener("pointercancel", cancel as EventListener, true);
    d.win.removeEventListener("keydown", key as EventListener, true);
  };
  function move(e: PointerEvent) {
    if (!same(e)) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < slop) return;
    moved = true;
    setHot(itemAt(d.menu(), p));
  }
  function up(e: PointerEvent) {
    if (!same(e)) return;
    const p = { x: e.clientX, y: e.clientY };
    const menu = d.menu();
    const item = itemAt(menu, p);
    const at = menu ? hitAt(menu, p) : null;
    const opener = d.opener?.() ?? null;
    const how = releaseAction({
      moved,
      onItem: !!item,
      onOpener: !!(opener && at && opener.contains(at)),
      inMenu: !!(menu && at && menu.contains(at)),
    });
    end();
    if (how === "trigger" && item) {
      item.click();
      swallowClick();
    } else if (how === "cancel") {
      d.close();
      swallowClick();
    }
  }
  function cancel(e: PointerEvent) {
    if (same(e)) end();
  }
  function key(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    end();
    d.close();
  }
  /** The browser's click after the release is not a second action. */
  const swallowClick = () => {
    const stop = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    d.win.addEventListener("click", stop, { capture: true, once: true });
    d.win.setTimeout(() => d.win.removeEventListener("click", stop, true), 300);
  };
  d.win.addEventListener("pointermove", move as EventListener, true);
  d.win.addEventListener("pointerup", up as EventListener, true);
  d.win.addEventListener("pointercancel", cancel as EventListener, true);
  d.win.addEventListener("keydown", key as EventListener, true);
  return { end };
}
