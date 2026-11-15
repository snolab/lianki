import { useEffect, useMemo, useRef, type RefObject } from "react";
import { advanceRead, intersectsReadRect, type ReadWatermark } from "./read-receipts";

/** Observe only the open, readable log. No receiving, loading, or scroll-to-end shortcut. */
export function useVisibleReads(p: {
  root: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  scope?: string;
  messages: unknown;
  throttleMs: number;
  onReadSeq?: (seq: number) => void;
}) {
  const enabled = useRef(p.enabled);
  enabled.current = p.enabled;
  const scope = useRef(p.scope);
  scope.current = p.scope;
  const send = useRef(p.onReadSeq);
  send.current = p.onReadSeq;
  const state = useMemo<{ current: ReadWatermark }>(
    () => ({ current: { seen: 0, sent: 0, at: null } }),
    [p.scope],
  );
  const hasSend = !!p.onReadSeq;
  useEffect(() => {
    const root = p.root.current;
    if (!p.enabled || !hasSend || !root || typeof IntersectionObserver === "undefined") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () =>
      active &&
      enabled.current &&
      scope.current === p.scope &&
      document.visibilityState === "visible" &&
      !root.hidden;
    const progress = (seq: number) => {
      const next = advanceRead(state.current, seq, Date.now(), visible(), p.throttleMs);
      state.current = next.state;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (next.emit !== undefined) send.current?.(next.emit);
      if (next.wait !== undefined) timer = setTimeout(() => progress(0), next.wait);
    };
    const sample = (el: Element) => {
      if (!visible()) return;
      const box = root.getBoundingClientRect();
      // The layout viewport can extend behind a mobile keyboard or outside a pinch-zoom.
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const clip = {
        top: Math.max(top, box.top),
        bottom: Math.min(top + (viewport?.height ?? window.innerHeight), box.bottom),
        left: Math.max(left, box.left),
        right: Math.min(left + (viewport?.width ?? window.innerWidth), box.right),
      };
      if (intersectsReadRect(Array.from(el.getClientRects()), clip)) {
        progress(Number(el.getAttribute("data-read-seq")));
      }
    };
    const nodes = Array.from(
      root.querySelectorAll('[data-testid="debug-chat-line"][data-read-seq]'),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) sample(e.target);
      },
      { root },
    );
    for (const node of nodes) observer.observe(node);
    const onVisible = () => {
      if (visible()) for (const node of nodes) sample(node);
      else {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.visualViewport?.addEventListener("resize", onVisible);
    window.visualViewport?.addEventListener("scroll", onVisible);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      window.visualViewport?.removeEventListener("resize", onVisible);
      window.visualViewport?.removeEventListener("scroll", onVisible);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [p.root, p.enabled, p.messages, p.throttleMs, state, hasSend]);
}
