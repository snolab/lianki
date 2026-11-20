import { MAX_SELECTION, MAX_SELECTION_NEARBY, cleanSelectionLocation, type SelectionLocation } from "./wire";

const BLOCK = "p,li,blockquote,pre,td,th,figcaption,h1,h2,h3,h4,h5,h6";
const SURROUNDING_FENCE = "[data-sensitive],[data-lk-sensitive],[data-lk-private-screen],[data-debug-chat],[data-lk-chat-host],input,textarea,script,style,template,noscript,[hidden],[aria-hidden=true]";
/** Do not read broad page containers or entire documents to get a short quote's context. */
const MAX_BLOCK_TEXT = 16_000;

function hidden(el: Element): boolean {
  if (el.closest("[hidden],[aria-hidden=true]")) return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || el.getClientRects().length === 0;
}

function selectorOf(el: Element, doc: Document): string | undefined {
  const parts: string[] = [];
  for (let node: Element | null = el, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
    const tag = node.tagName.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) return;
    const id = node.id;
    const same = node.parentElement ? [...node.parentElement.children].filter(n => n.tagName === node!.tagName) : [];
    parts.unshift(/^[A-Za-z_][\w-]{0,79}$/.test(id) ? `#${id}` : `${tag}:nth-of-type(${Math.max(1, same.indexOf(node) + 1)})`);
    const selector = parts.join(" > ");
    if (selector.length > 300) return;
    try { if (doc.querySelectorAll(selector).length === 1) return selector; } catch { return; }
  }
}

function headingOf(start: Element, excluded: (el: Element) => boolean): string | undefined {
  const scope = start.closest("section,article,main") ?? start.ownerDocument.body;
  if (!scope) return;
  let heading: string | undefined;
  for (const h of scope.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (excluded(h) || hidden(h) || h.querySelector(SURROUNDING_FENCE) || [...h.querySelectorAll("*")].some(hidden)) continue;
    if (h === start || h.contains(start) || (h.compareDocumentPosition(start) & 4)) {
      const value = h.textContent?.replace(/\s+/g, " ").trim();
      if (value) heading = value.slice(0, MAX_SELECTION_NEARBY);
    }
  }
  return heading;
}

/** Location is taken at selection time, before focusing chat clears the range.
 * The caller supplies the same private/chat fences used to capture the quote.
 * Never reads a field's unselected value, a whole page, or another frame. */
export function selectionLocation(doc: Document, excluded: (el: Element) => boolean): SelectionLocation | undefined {
  try {
    const win = doc.defaultView;
    const active = doc.activeElement;
    const field = active && /^(INPUT|TEXTAREA)$/.test(active.tagName) ? active as HTMLInputElement | HTMLTextAreaElement : null;
    const sel = doc.getSelection();
    let element: Element | null = null, range: Range | null = null;
    if (field && !excluded(field) && field.selectionStart !== null && field.selectionEnd !== null && field.selectionEnd > field.selectionStart) element = field;
    else if (sel && sel.rangeCount === 1 && !sel.isCollapsed) {
      range = sel.getRangeAt(0);
      element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    }
    if (!element || excluded(element) || hidden(element)) return;
    const out: SelectionLocation = { kind: field === element ? "field" : "dom" };
    const box = range?.getBoundingClientRect?.() ?? element.getBoundingClientRect?.();
    if (win && box) {
      out.rect = { x: box.left + win.scrollX, y: box.top + win.scrollY, width: box.width, height: box.height };
      out.viewport = { width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY };
    }
    if (out.kind === "field" && field) {
      out.selector = selectorOf(field, doc);
      const start = field.selectionStart!, selected = field.value.slice(start, field.selectionEnd!);
      out.start = start + selected.length - selected.trimStart().length;
      out.end = out.start + Math.min(selected.trim().length, MAX_SELECTION);
      return cleanSelectionLocation(out);
    }
    if (!range) return;
    const common = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
    const block = common?.closest(BLOCK) ?? common;
    out.heading = headingOf(element, excluded);
    if (!block) return cleanSelectionLocation(out);
    out.selector = selectorOf(block, doc);
    // A safe quote beside private content must not bring that content along.
    const broad = /^(BODY|HTML|MAIN|ARTICLE)$/.test(block.tagName);
    const safe = !broad && !excluded(block) && !block.querySelector(SURROUNDING_FENCE);
    const hiddenChild = safe && [...block.querySelectorAll("*")].some(hidden);
    if (safe && !hiddenChild && (block.textContent?.length ?? 0) <= MAX_BLOCK_TEXT) {
      const before = range.cloneRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
      const after = range.cloneRange(); after.selectNodeContents(block); after.setStart(range.endContainer, range.endOffset);
      const prefix = before.toString(), suffix = after.toString();
      const exact = range.toString();
      // Match the trimmed/capped quote sent on the wire, rather than the user's
      // incidental whitespace at either end of a native selection.
      const leading = exact.length - exact.trimStart().length;
      out.start = prefix.length + leading;
      out.end = out.start + Math.min(exact.trim().length, MAX_SELECTION);
      out.before = (prefix + exact.slice(0, leading)).slice(-MAX_SELECTION_NEARBY);
      out.after = (exact.slice(leading + out.end - out.start) + suffix).slice(0, MAX_SELECTION_NEARBY);
    }
    return cleanSelectionLocation(out);
  } catch { return; }
}
