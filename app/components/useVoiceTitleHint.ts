"use client";
/**
 * The tab title says Lianki's voice is still on (voice-bg.ts titleHint): on a
 * computer, while the mic listens or a reading goes on in a tab he is not
 * looking at. Event-driven: the voice session's changes, visibility, focus,
 * and the page changing its own title (a route change) — never a timer.
 */
import { useEffect } from "react";
import { voice } from "@lianki/debug-chat/voice";
import { baseTitle, hintedTitle, isDesktop, titleHint } from "@lianki/debug-chat/voice-bg";
import { voiceBgWords } from "@lianki/debug-chat/ui-strings";

export function useVoiceTitleHint() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const words = voiceBgWords();
    const sync = () => {
      const kind = titleHint({
        desktop: isDesktop(),
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        voice: voice().state(),
      });
      const next = hintedTitle(document.title, words, kind);
      if (next !== document.title) document.title = next;
    };
    const unsub = voice().subscribe(sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    // The page set its own title (navigation): the hint goes back in front if it is due.
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(sync);
    mo?.observe(document.head, { subtree: true, childList: true, characterData: true });
    sync();
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      mo?.disconnect();
      const base = baseTitle(document.title, words);
      if (base !== document.title) document.title = base;
    };
  }, []);
}
