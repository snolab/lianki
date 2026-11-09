/**
 * Where a voice line was spoken (wire.ts SttScene): the page's path and
 * title, and the text on its screen — the deck's words, the book's paragraph.
 * It rides on the voice line so the agent's polish can fix misheard words
 * from what the owner was looking at (polish.ts), not from a guess.
 *
 * The screen text is what is visible in the viewport, outside the chat
 * itself (CHAT_FENCE), in document order, up to MAX_SCENE_SCREEN characters.
 */
import { CHAT_FENCE } from "./attach";
import { cleanScene, MAX_SCENE_SCREEN, type SttScene } from "./wire";

/** Marks a page whose text must never leave as a voice line's context. */
export const PRIVATE_SCREEN = "[data-lk-private-screen]";

/** The text on screen: visible text nodes in the viewport, outside the chat. */
export function screenText(doc: Document = document, max = MAX_SCENE_SCREEN): string {
  const win = doc.defaultView;
  if (!doc.body || !win) return "";
  // A page that shows private speech (/vibe, a transcript in /read: docs/vibe.md):
  // its text never rides on a chat line.
  if (doc.querySelector(PRIVATE_SCREEN)) return "";
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const parts: string[] = [];
  let len = 0;
  for (let n = walker.nextNode(); n && len < max; n = walker.nextNode()) {
    const t = n.textContent?.replace(/\s+/g, " ").trim();
    const el = n.parentElement;
    if (!t || !el || el.closest(`script, style, noscript, template, ${CHAT_FENCE}`)) continue;
    // Hidden by CSS (display, visibility, opacity 0) is not on screen.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw)
      continue;
    parts.push(t);
    len += t.length + 1;
  }
  return parts.join(" ").slice(0, max);
}

/** This page's scene, bounded as the hub bounds it; undefined outside a browser. */
export function pageScene(doc: Document | undefined = globalThis.document): SttScene | undefined {
  if (!doc?.defaultView) return undefined;
  try {
    return cleanScene({ path: doc.defaultView.location.pathname, title: doc.title, screen: screenText(doc) });
  } catch {
    return undefined;
  }
}
