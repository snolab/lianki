/**
 * The subframe half: report keys, nothing else.
 *
 * Kept as its own content script, separate from `content.ts`, because it is
 * loaded into every frame on every page — ad iframes included. The top-frame
 * bundle is 77 KB and has no business being parsed there; this is a few
 * hundred bytes.
 *
 * Why it exists at all: keyboard events go to the focused document and never
 * cross a document boundary. A page that reads inside an iframe — calibre-web
 * renders a whole book into a sandboxed `srcdoc` frame — swallows every key
 * Lianki listens for, and no userscript manager will inject there to notice.
 * An extension can.
 */
const KEY_RELAY = "lianki:hotkey";

// `all_frames` covers the top frame too; that one has the real thing.
if (window.self !== window.top) {
  document.addEventListener(
    "keydown",
    (e) => {
      try {
        void chrome.runtime
          .sendMessage({
            type: KEY_RELAY,
            code: e.code,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
          })
          .catch(() => {});
      } catch {
        // Extension context gone (reloaded or updated). Nothing to do.
      }
    },
    true,
  );
}
