/**
 * Frame-to-top relay.
 *
 * Keyboard events are delivered to the focused document and never cross a
 * document boundary, so a page that reads inside an iframe — calibre-web renders
 * a whole book into a sandboxed `srcdoc` frame — swallows every key Lianki
 * listens for. The content script runs in that frame too (`all_frames`), so it
 * can see the key; it just cannot reach the top frame directly.
 *
 * It goes through here rather than `postMessage` for one reason: trust. In the
 * page world the receiver has to decide whether a message really came from one
 * of its own frames, and the obvious test — is `event.source` in `window.frames`
 * — silently fails across isolated worlds. That cost a day. `sender.tab.id` is
 * told to us by the browser and cannot be forged by a page.
 */
const KEY_RELAY = "lianki:hotkey";

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== KEY_RELAY) return;
  const tabId = sender.tab?.id;
  // A frame reported a key; hand it to the top frame of that same tab.
  if (tabId != null && sender.frameId !== 0) {
    void chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
  }
});
