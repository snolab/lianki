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
    if (box?.hasAttribute("data-minimized"))
      box.querySelector<HTMLElement>('[data-testid="debug-chat-pill-min"]')?.click();
  }, 320);
}
