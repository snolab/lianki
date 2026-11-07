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
/** Full screen's side padding, FULL_SCREEN_STYLE's, in viewport units (the section spans the viewport). */
const FULL_PAD_RIGHT = "max(0.75rem, env(safe-area-inset-right), calc((100vw - 48rem) / 2))";

/**
 * Full screen keeps the bar at the panel's span: its width, its right inset
 * and the box's sideways offset (`dx`, a drag's), so the mark, the + and the
 * mic do not move as the chat fills the screen (owner, 2026-11-07: the mic's
 * place must not change). Only the log takes the whole column. A panel dragged
 * up still has its bar at the bottom in full screen: the log is above it.
 */
export function fullBarSpan(dx: number) {
  return {
    width: PANEL_W,
    alignSelf: "flex-end",
    marginRight: `calc(${PANEL_RIGHT} - ${FULL_PAD_RIGHT})`,
    translate: `${Math.round(dx * 100) / 100}px 0`,
  } as const;
}

/**
 * The section's style in full screen: the visible area, edge to edge; the
 * content in a readable column (48rem at most, centred on a wide screen),
 * clear of the notch, the home indicator and a landscape notch's sides.
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
  paddingLeft: "max(0.75rem, env(safe-area-inset-left), calc((100% - 48rem) / 2))",
  paddingRight: "max(0.75rem, env(safe-area-inset-right), calc((100% - 48rem) / 2))",
} as const;

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
