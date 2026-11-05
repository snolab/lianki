/**
 * The DOM side of select-fence.ts: a selection started in the chat stays in
 * the chat. Listeners only (no timers): pointerdown / pointermove / pointerup
 * / pointercancel, `selectionchange` and blur, all on the window.
 *
 * Installed once per page however many chats mount (a count): each
 * DebugChat calls installSelectFence() in an effect and the returned
 * function on unmount.
 */
import {
  FENCE_ATTR,
  FENCE_CSS,
  FENCE_SELECTOR,
  SELECTABLE_SELECTOR,
  type Hint,
  clampSide,
  fenceUp,
  pointerHint,
} from "./select-fence";

const STYLE_ID = "lk-chat-select-fence";

let installs = 0;
let uninstall: (() => void) | null = null;

/** Turn the fence on for this page; the result turns it off again (last one out). */
export function installSelectFence(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (installs++ === 0) uninstall = wire(window, document);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--installs === 0) {
      uninstall?.();
      uninstall = null;
    }
  };
}

function elementOf(n: Node | null): Element | null {
  if (!n) return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/** The chat a node is in, if any (not across a shadow root: an embed is fenced by its own root). */
function fenceOf(n: Node | null): Element | null {
  return elementOf(n)?.closest(FENCE_SELECTOR) ?? null;
}

/** The first or last selectable text in the chat, as a selection point. */
function edgeOf(fence: Element, side: "start" | "end"): [Node, number] {
  const doc = fence.ownerDocument;
  const walk = doc.createTreeWalker(fence, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) =>
      t.nodeValue?.trim() && t.parentElement?.closest(SELECTABLE_SELECTOR)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  if (side === "start") {
    const t = walk.nextNode();
    return t ? [t, 0] : [fence, 0];
  }
  let last: Node | null = null;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) last = t;
  return last ? [last, last.nodeValue!.length] : [fence, fence.childNodes.length];
}

function wire(win: Window, doc: Document): () => void {
  const style = doc.getElementById(STYLE_ID) ?? doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = FENCE_CSS;
  if (!style.isConnected) (doc.head ?? doc.documentElement).append(style);

  let pressed = false;
  /** The selection was started by a press on a line (fenceUp). */
  let armed = false;
  /** The pointer's last height while a line is pressed (which way it left the chat). */
  let y: number | null = null;

  const sync = () => {
    const s = win.getSelection();
    const up = fenceUp({
      armed,
      pressed,
      anchoredInChat: !!s && !!fenceOf(s.anchorNode),
      collapsed: !s || s.isCollapsed,
    });
    if (up) doc.documentElement.setAttribute(FENCE_ATTR, "");
    else doc.documentElement.removeAttribute(FENCE_ATTR);
  };

  const clamp = () => {
    const s = win.getSelection();
    if (!s || !s.anchorNode || !s.focusNode || s.isCollapsed) return;
    const fence = fenceOf(s.anchorNode);
    if (!fence) return;
    const r = doc.createRange();
    r.selectNodeContents(fence);
    let cmp: number;
    try {
      cmp = r.comparePoint(s.focusNode, s.focusOffset);
    } catch {
      return; // the focus is in another document or tree: not ours to move
    }
    let hint: Hint;
    if (pressed && y !== null) {
      const a = elementOf(s.anchorNode)?.getBoundingClientRect();
      hint = pointerHint(y, fence.getBoundingClientRect(), a);
    }
    const side = clampSide(cmp, hint);
    if (!side) return;
    const [node, offset] = edgeOf(fence, side);
    try {
      s.extend(node, offset);
    } catch {
      s.setBaseAndExtent(s.anchorNode, s.anchorOffset, node, offset);
    }
  };

  const onDown = (e: PointerEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    // Only a press on a line's text: a tap on the chat's buttons never restyles the page.
    const inChat = !!fenceOf(t);
    pressed = inChat && !!t?.closest(SELECTABLE_SELECTOR);
    y = pressed ? e.clientY : null;
    if (pressed) armed = true;
    // A press outside the chat drops the fence before the page's own selection starts.
    else if (!inChat) armed = false;
    sync();
  };
  const onMove = (e: PointerEvent) => {
    if (pressed) y = e.clientY;
  };
  const onUp = () => {
    pressed = false;
    y = null;
    sync();
  };
  const onSelection = () => {
    clamp();
    sync();
  };

  const capture = { capture: true } as const;
  const passive = { capture: true, passive: true } as const;
  win.addEventListener("pointerdown", onDown, capture);
  win.addEventListener("pointermove", onMove, passive);
  win.addEventListener("pointerup", onUp, capture);
  win.addEventListener("pointercancel", onUp, capture);
  win.addEventListener("blur", onUp);
  doc.addEventListener("selectionchange", onSelection);
  return () => {
    win.removeEventListener("pointerdown", onDown, capture);
    win.removeEventListener("pointermove", onMove, passive);
    win.removeEventListener("pointerup", onUp, capture);
    win.removeEventListener("pointercancel", onUp, capture);
    win.removeEventListener("blur", onUp);
    doc.removeEventListener("selectionchange", onSelection);
    doc.documentElement.removeAttribute(FENCE_ATTR);
    // The style stays: inert without FENCE_ATTR, and a hot-swapped copy of this module may share it.
  };
}
