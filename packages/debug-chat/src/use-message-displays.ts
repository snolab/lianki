import { useEffect, type RefObject } from "react";
import { messageTelemetry } from "./message-telemetry";

/** First viewport intersection of a real row, including compact and floating rows. */
export function useMessageDisplays(root: RefObject<HTMLElement | null>, revision: { messages: unknown; open: boolean; compact: boolean; fullLog: unknown; tree: unknown }) {
  useEffect(() => {
    const metrics = messageTelemetry();
    const el = root.current;
    if (!metrics.enabled() || !el || typeof IntersectionObserver === "undefined") return;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-msg][data-testid]"));
    const observer = new IntersectionObserver((entries) => {
      if (document.visibilityState !== "visible") return;
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRect.width <= 0 || entry.intersectionRect.height <= 0) continue;
        const node = entry.target as HTMLElement;
        if (getComputedStyle(node).visibility !== "visible") continue;
        metrics.displayed(node.dataset.msg ?? "");
      }
    });
    const observe = () => {
      observer.disconnect();
      if (document.visibilityState === "visible") for (const node of nodes) observer.observe(node);
    };
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", observe);
    };
  }, [root, revision.messages, revision.open, revision.compact, revision.fullLog, revision.tree]);
}
