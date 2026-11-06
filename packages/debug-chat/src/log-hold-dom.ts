/**
 * The DOM side of log-engage.ts: a press-and-hold on the click-through
 * history engages it and selects the line under the finger. Listeners only
 * (pointerdown / pointermove / pointerup / pointercancel, scroll, click,
 * contextmenu, selectionchange, all on the window or document) and one
 * HOLD_MS timer per press, started by the press and cancelled by its end:
 * nothing polls.
 *
 * The history takes no events at rest, so the press itself goes to the page
 * under it; this sees it at the window (capture) and checks the log's box.
 * While a touch hold may be under way, and after it fires for the rest of
 * the press, HOLD_ATTR on <html> makes the page outside the chat
 * non-selectable with no touch callout, so the platform's own long-press
 * does not select the page's text or open a link preview under the finger.
 * The click the fired press would end with is swallowed, so the hold never
 * presses the page's button under it.
 */
import {
  HOLD_ATTR,
  HOLD_CSS,
  HOLD_MS,
  type Held,
  heldAfterPress,
  holdStarts,
  holdStill,
  lineAt,
} from "./log-engage";
import { SELECTABLE_SELECTOR } from "./select-fence";

const STYLE_ID = "lk-chat-hold";

export function wireLogHold(o: {
  /** The shown history (the log, or the tree in its place), or null. */
  log: () => HTMLElement | null;
  /** The chat's box ([data-debug-chat]). */
  chat: () => Element | null;
  /** The input in use or the mic on (engaged without a hold). */
  busy: () => boolean;
  /** `held` changed. */
  onHeld: (held: Held) => void;
  /** Gets the way to set `held` from outside, so a press outside drops that too. */
  onReady?: (hold: (held: Held) => void) => void;
}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const win = window;
  const doc = document;
  const style = doc.getElementById(STYLE_ID) ?? doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HOLD_CSS;
  if (!style.isConnected) (doc.head ?? doc.documentElement).append(style);

  let held: Held = false;
  const setHeld = (v: Held) => {
    if (v === held) return;
    held = v;
    o.onHeld(v);
  };
  o.onReady?.(setHeld);
  /** The press a hold may come of: where and which pointer. */
  let press: { id: number; x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The hold fired during this press (its click and context menu are ours). */
  let fired = false;
  let swallowClick = false;

  const lift = () => doc.documentElement.removeAttribute(HOLD_ATTR);
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    press = null;
    if (!fired) lift();
  };
  const within = (e: Event, el: Element | null) => !!el && e.composedPath().includes(el);

  const fire = () => {
    timer = undefined;
    const p = press;
    const el = o.log();
    if (!p || !el) return;
    fired = true;
    doc.documentElement.setAttribute(HOLD_ATTR, "");
    setHeld(held || "rest");
    // Select the line under the finger: Copy (or ⌘C) is one step away.
    const lines = [...el.querySelectorAll<HTMLElement>(SELECTABLE_SELECTOR)];
    const i = lineAt(
      lines.map((l) => l.getBoundingClientRect()),
      p.x,
      p.y,
    );
    const line = lines[i];
    const s = win.getSelection();
    if (!line || !s) return;
    const r = doc.createRange();
    r.selectNodeContents(line);
    s.removeAllRanges();
    s.addRange(r);
  };

  const onDown = (e: PointerEvent) => {
    swallowClick = false;
    fired = false;
    cancel();
    const el = o.log();
    const mine = within(e, o.chat());
    setHeld(heldAfterPress(held, { inChat: mine, inLog: within(e, el), busy: o.busy() }));
    if (mine) return;
    const box = el && !el.hidden ? el.getBoundingClientRect() : null;
    if (
      !holdStarts({
        engaged: o.busy() || !!held,
        log: box,
        button: e.button,
        x: e.clientX,
        y: e.clientY,
      })
    )
      return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    timer = setTimeout(fire, HOLD_MS);
    // A finger's long-press would select the page's text under it first.
    if (e.pointerType === "touch") doc.documentElement.setAttribute(HOLD_ATTR, "");
  };
  const onMove = (e: PointerEvent) => {
    if (press && e.pointerId === press.id && !holdStill(press, { x: e.clientX, y: e.clientY }))
      cancel();
  };
  const onUp = (e: PointerEvent) => {
    if (fired && e.type === "pointerup") swallowClick = true;
    cancel();
    fired = false;
    lift();
  };
  const onClick = (e: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onMenu = (e: Event) => {
    if (fired) e.preventDefault();
  };
  const onScroll = () => {
    if (press) cancel();
  };
  const onSelection = () => {
    const s = win.getSelection();
    const c = o.chat();
    if (!s || s.isCollapsed || !c || !s.anchorNode) return;
    if (c.contains(s.anchorNode)) setHeld(held || "rest");
  };

  const capture = { capture: true } as const;
  const passive = { capture: true, passive: true } as const;
  win.addEventListener("pointerdown", onDown, capture);
  win.addEventListener("pointermove", onMove, passive);
  win.addEventListener("pointerup", onUp, capture);
  win.addEventListener("pointercancel", onUp, capture);
  win.addEventListener("click", onClick, capture);
  win.addEventListener("contextmenu", onMenu, capture);
  win.addEventListener("scroll", onScroll, passive);
  doc.addEventListener("selectionchange", onSelection);
  return () => {
    clearTimeout(timer);
    lift();
    win.removeEventListener("pointerdown", onDown, capture);
    win.removeEventListener("pointermove", onMove, passive);
    win.removeEventListener("pointerup", onUp, capture);
    win.removeEventListener("pointercancel", onUp, capture);
    win.removeEventListener("click", onClick, capture);
    win.removeEventListener("contextmenu", onMenu, capture);
    win.removeEventListener("scroll", onScroll, passive);
    doc.removeEventListener("selectionchange", onSelection);
  };
}
