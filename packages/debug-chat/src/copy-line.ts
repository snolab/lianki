/**
 * Copying a chat line (owner, 2026-11-05: "这里复制不了" on the iPhone PWA).
 *
 * The chat box is click-through (`pointer-events: none` on the section, so
 * the page under it stays usable), and the log inherited it: on iOS a
 * long-press on text that does not take the pointer never selects it, so
 * there was no Copy. Each line's own text now takes the pointer and is
 * selectable (LINE_SELECTABLE); the empty space around it stays
 * click-through. Each line also has a copy button (CopyLine.tsx), which
 * copies the plain text through `copyText`.
 */

/**
 * The classes that make a line's text selectable: it takes the pointer
 * (its parents are click-through), `user-select: text` (WebKit's prefixed
 * one too) and the iOS long-press callout back on, should a host or a
 * parent turn either off.
 */
export const LINE_SELECTABLE =
  "pointer-events-auto select-text [-webkit-user-select:text] [-webkit-touch-callout:default]";

/** The bits of `navigator.clipboard` copyText uses (a mock in tests). */
export type ClipboardLike = { writeText(text: string): Promise<void> };

/**
 * Put `text` on the clipboard: the async Clipboard API, else (an older
 * WebView, an insecure origin) a hidden textarea and `execCommand("copy")`.
 * Resolves true when it was copied.
 */
export async function copyText(
  text: string,
  clip: ClipboardLike | undefined = globalThis.navigator?.clipboard,
  doc: Document | undefined = globalThis.document,
): Promise<boolean> {
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // Refused (no focus, no permission): try the old way.
    }
  }
  if (!doc?.body) return false;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  doc.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** The plain text a line's copy button copies: an ask's questions, the raw text while shown, else the text. */
export function lineCopyText(m: {
  text: string;
  raw?: string;
  ask?: { questions: { question: string }[] };
  /** Its raw (unpolished) text is shown in place of the polished one. */
  showRaw?: boolean;
}): string {
  if (m.ask) return m.ask.questions.map((q) => q.question).join("\n");
  if (m.showRaw && m.raw !== undefined) return m.raw;
  return m.text;
}
