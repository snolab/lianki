/**
 * Full screen: the open chat fills the whole app, and a minimise control (or
 * Escape, or Back) returns it to the panel it was (owner, 2026-11-07:
 * "给我的伙伴全屏"). docs/dev-debug-widget.md, "Full screen".
 *
 * Only the view changes: the same log, input, mic and draft, restyled in
 * place, so the thread, the draft, the scroll and the mic are as they were.
 * Whether it is on is this device's view state (`lk:pref:chat-view`, `full`;
 * ui-store.ts chatPrefs), never synced.
 */

/**
 * Who may use it: the flag `partner.fullscreen` is on (the host reads it on
 * the server and passes it down), or the hub verified this as the owner's
 * page (`flag || owner`, docs/feature-flags.md). Never on another site (the
 * userscript's shadow widget, the partner frame): there the chat is a small
 * box over someone else's page.
 */
export function fullScreenAllowed(d: { flag: boolean; owner: boolean; embedded: boolean }) {
  return !d.embedded && (d.flag || d.owner);
}

/** Full screen now: allowed, chosen on this device, and the chat open (a pill is never full screen). */
export function fullScreenOn(d: { allowed: boolean; pref: boolean; open: boolean }) {
  return d.allowed && d.pref && d.open;
}

/** Pinched in further than this, the visual viewport is the user's zoom, not a keyboard (keyboard-lift.ts). */
const ZOOMED = 1.05;

/**
 * The full-screen box (layout px): the visible area, so the composer sits
 * just above the on-screen keyboard. On iOS the keyboard shrinks only the
 * visual viewport (`offsetTop`, `height`) and may pan it; a fixed box sized to
 * the layout viewport would put the input under the keyboard. Zoomed in, or
 * without a visual viewport, it is the whole layout viewport.
 *
 * `keyboard`: the visible area ends above the layout viewport's bottom, so
 * the home indicator is under the keyboard and the bottom safe area is not
 * padded.
 */
export function fullScreenBox(d: {
  innerHeight: number;
  vv?: { offsetTop: number; height: number; scale?: number } | null;
}): { top: number; height: number; keyboard: boolean } {
  const vv = d.vv;
  if (!vv || (vv.scale ?? 1) > ZOOMED || !(vv.height > 0))
    return { top: 0, height: Math.round(d.innerHeight), keyboard: false };
  const top = Math.max(0, Math.round(vv.offsetTop));
  const height = Math.round(Math.min(vv.height, d.innerHeight - top));
  return { top, height, keyboard: top + height < Math.round(d.innerHeight) - 1 };
}

/** The CSS variables the box reads (set straight on the section from visualViewport events: no render). */
export const FULL_TOP_VAR = "--lk-full-top";
export const FULL_H_VAR = "--lk-full-h";
export const FULL_PB_VAR = "--lk-full-pb";

/**
 * The bottom padding: the home indicator's safe area, unless the keyboard
 * covers it, and the host's bottom island's reserve, as the panel rests above
 * it: so the bar, and the mic in it, stay where the panel had them.
 */
export const fullBottomPad = (keyboard: boolean) =>
  keyboard ? "8px" : `calc(env(safe-area-inset-bottom) + 8px + ${RESERVE})`;

const RESERVE = "var(--lk-bottom-reserve, 0px)";
/** The panel's width and its inset from the right edge (DebugChat.tsx, the section's classes). */
export const PANEL_W = "min(20rem, calc(100vw - 1rem))";
export const PANEL_RIGHT = "calc(0.5rem + env(safe-area-inset-right))";

/**
 * Where full screen becomes a sidebar. Owner, 2026-11-07 20:3x JST: "35em":
 * wider than this, full screen is a full-height panel docked to the right
 * edge, the page still usable beside it; narrower, it is the whole screen,
 * the input across its full width. In em, as he gave it (a media query's em
 * is the browser's default text size, so a larger default text gets the
 * phone layout a little sooner).
 */
export const SIDEBAR_QUERY = "(min-width: 35em)";

/**
 * The sidebar's width. The app has no drag-to-resize pattern yet, so a fixed
 * one: 20rem (the panel's own width) at the breakpoint, growing with the
 * window up to 28rem, which keeps the chat's lines readable and leaves the
 * page most of a desktop window.
 */
export const SIDEBAR_W = "clamp(20rem, 32vw, 28rem)";

/** Full screen's side padding (FULL_SCREEN_STYLE), and the bar's gutter there: the panel's own 0.5rem inset. */
const PAD = (side: "left" | "right") => `max(0.75rem, env(safe-area-inset-${side}))`;
const GUTTER = (side: "left" | "right") => `max(0.5rem, env(safe-area-inset-${side}))`;

/**
 * The bar in full screen (owner, 2026-11-07 20:30 JST: the input spans the
 * screen): the full width inside the safe areas, less the panel's own 0.5rem
 * gutter, so the cluster [mark | + | mic] is at its left and the input takes
 * the rest. The gutter is the panel's right inset, so where the panel already
 * spans the screen (320 px) the mic does not move at all; on a wider phone it
 * moves left to that gutter. In the sidebar the bar spans the sidebar, as the
 * log does. A panel dragged up still has its bar at the bottom: the log is
 * above it.
 */
export function fullBarSpan(sidebar: boolean) {
  if (sidebar) return { alignSelf: "stretch", width: "auto" } as const;
  return {
    alignSelf: "stretch",
    width: "auto",
    marginLeft: `calc(${GUTTER("left")} - ${PAD("left")})`,
    marginRight: `calc(${GUTTER("right")} - ${PAD("right")})`,
  } as const;
}

/**
 * The section's style in full screen on a phone (narrower than
 * SIDEBAR_QUERY): the visible area, edge to edge, clear of the notch, the
 * home indicator and a landscape notch's sides.
 */
export const FULL_SCREEN_STYLE = {
  transform: "none",
  top: `var(${FULL_TOP_VAR}, 0px)`,
  height: `var(${FULL_H_VAR}, 100dvh)`,
  left: 0,
  right: 0,
  bottom: "auto",
  width: "auto",
  borderRadius: 0,
  paddingTop: "calc(env(safe-area-inset-top) + 4px)",
  paddingBottom: `var(${FULL_PB_VAR}, ${fullBottomPad(false)})`,
  paddingLeft: PAD("left"),
  paddingRight: PAD("right"),
} as const;

/**
 * Full screen on a wider screen (SIDEBAR_QUERY): a full-height sidebar docked
 * to the right edge, SIDEBAR_W wide; log and bar fill its width. The page
 * beside it stays usable (sidebarReserve).
 */
export const FULL_SIDEBAR_STYLE = {
  ...FULL_SCREEN_STYLE,
  left: "auto",
  width: SIDEBAR_W,
  paddingLeft: "0.5rem",
  paddingRight: GUTTER("right"),
  borderLeft: "1px solid color-mix(in oklch, currentColor 18%, transparent)",
} as const;

/** The page root's variable while the sidebar is up: its width, for a host's own fixed bars. */
export const SIDEBAR_RESERVE_VAR = "--lk-chat-side";

/**
 * While the sidebar is up the page's root is padded on the right by its
 * width, so the page's content reflows beside it instead of under it and
 * scrolls as ever. Returns the way back (the root's own padding restored).
 */
export function sidebarReserve(root: HTMLElement) {
  const before = root.style.paddingRight;
  root.style.setProperty(SIDEBAR_RESERVE_VAR, SIDEBAR_W);
  root.style.paddingRight = `var(${SIDEBAR_RESERVE_VAR})`;
  return () => {
    root.style.removeProperty(SIDEBAR_RESERVE_VAR);
    root.style.paddingRight = before;
  };
}

/** The log in full screen: it takes the height the bar leaves, and scrolls inside it. */
export const FULL_LOG_STYLE = { maxHeight: "none", flex: "1 1 0%", minHeight: 0 } as const;

/**
 * Escape leaves full screen unless something nearer takes it first: the tree
 * or another panel, the + menu, or (on another site) a key typed outside the
 * chat. The panel's own Escape handlers run first.
 */
export function escapeLeaves(d: { full: boolean; panelOpen: boolean; plusMenu: boolean }) {
  return d.full && !d.panelOpen && !d.plusMenu;
}
