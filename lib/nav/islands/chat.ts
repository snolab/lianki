"use client";

import { sendAction } from "@/lib/islands/actions";

/**
 * Open the Learning Partner chat (packages/debug-chat). It sends the
 * `chat.open` action first. If the bar is still minimized a moment later
 * (nothing listened), it taps the bar's own mark instead.
 */
export function openChat() {
  sendAction("chat.open", {});
  setTimeout(() => {
    const box = document.querySelector("[data-debug-chat]");
    // The pill's Li restores; the mark beside it now tucks (packages/debug-chat/src/fold.ts).
    // An older widget has no Li: there the mark still restores.
    if (box?.hasAttribute("data-minimized"))
      (
        box.querySelector<HTMLElement>("[data-chat-restore]") ??
        box.querySelector<HTMLElement>('[data-testid="debug-chat-pill-min"]')
      )?.click();
  }, 320);
}
