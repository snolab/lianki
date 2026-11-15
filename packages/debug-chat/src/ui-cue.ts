/**
 * A view change asked by the agent, shown to him as it happens (owner,
 * 2026-11-15: "全屏时你帮我把菜单点开…高亮全屏按钮区域"). The chat lane sends
 * `{type: "ui", op: "fullscreen", on}` (`lianki-dev ui fullscreen --on|--off`,
 * lib/dev-eval.ts); the hub relays it to his pages; the page hands it to the
 * chat as a window event; the chat opens its menu, the Full screen row pulses
 * in the seal red for CUE_MS, then the switch flips and the menu closes. The
 * change is the same one his own tap makes (ui-store.ts chatPrefs `full`).
 * docs/dev-debug-widget.md, "Full screen".
 */

/** The window event the page dispatches for the chat (detail: ChatUi). */
export const CHAT_UI_EVENT = "lk:chat-ui";

/** What the chat can be asked to change. */
export type ChatUi = { op: "fullscreen"; on: boolean };

/** A hub message (or an event's detail) → the change it asks for, or null for anything else. */
export function chatUiOf(raw: unknown): ChatUi | null {
  const m = raw as { op?: unknown; on?: unknown } | null;
  if (!m || typeof m !== "object" || m.op !== "fullscreen" || typeof m.on !== "boolean")
    return null;
  return { op: "fullscreen", on: m.on };
}

/** The page side: pass a hub `{type: "ui"}` on to the chat. False when it asks for nothing known. */
export function dispatchChatUi(target: EventTarget, raw: unknown): boolean {
  const ui = chatUiOf(raw);
  if (!ui) return false;
  target.dispatchEvent(new CustomEvent(CHAT_UI_EVENT, { detail: ui }));
  return true;
}

/** How long the row is highlighted before the switch flips (ms). */
export const CUE_MS = 600;

export type CueDeps = {
  /** Opens the chat's menu (and the chat, when it must be open to show the row). */
  openMenu(): void;
  /** Highlights the row (true) or stops (false). */
  cue(on: boolean): void;
  /** Makes the change. */
  apply(): void;
  closeMenu(): void;
  /** A timer; returns its cancel. Default setTimeout. */
  later?: (fn: () => void, ms: number) => () => void;
};

const timeout = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * The sequence: open the menu and highlight the row at once; CUE_MS later
 * stop the highlight, make the change and close the menu. Returns a cancel
 * (a newer cue, or the chat unmounting): the highlight stops, nothing changes,
 * the menu stays as it is.
 */
export function runMenuCue(d: CueDeps): () => void {
  const later = d.later ?? timeout;
  let done = false;
  d.openMenu();
  d.cue(true);
  const stop = later(() => {
    done = true;
    d.cue(false);
    d.apply();
    d.closeMenu();
  }, CUE_MS);
  return () => {
    if (done) return;
    done = true;
    stop();
    d.cue(false);
  };
}

/** The row while highlighted: an outline in the theme's seal red (oklch fallback), inside the row. */
export const CUE_OUTLINE = {
  outline: "2px solid var(--lk-seal-on, oklch(0.53 0.207 22.3))",
  outlineOffset: "-2px",
  borderRadius: "0.375rem",
} as const;

/** One pulse over CUE_MS: a seal-red glow that swells and fades. */
export const CUE_KEYFRAMES: Keyframe[] = [
  { boxShadow: "0 0 0 0 color-mix(in oklch, var(--lk-seal-on, oklch(0.53 0.207 22.3)) 55%, transparent)" },
  { boxShadow: "0 0 0 6px color-mix(in oklch, var(--lk-seal-on, oklch(0.53 0.207 22.3)) 0%, transparent)" },
];

type Pulsable = {
  scrollIntoView?: (o: ScrollIntoViewOptions) => void;
  animate?: (k: Keyframe[], o: KeyframeAnimationOptions) => unknown;
};

/**
 * Brings the highlighted row into the menu's view (it scrolls) and pulses it
 * once, unless he asked for reduced motion: then the outline alone shows it.
 */
export function pulseRow(el: Pulsable, reduce: boolean) {
  el.scrollIntoView?.({ block: "nearest" });
  if (!reduce) el.animate?.(CUE_KEYFRAMES, { duration: CUE_MS, easing: "ease-out" });
}
