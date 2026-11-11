import { useEffect, useRef } from "react";
import { subscribeLevel } from "./voice-level";

/**
 * The caret where the transcript will land, while the mic is on: it grows and
 * brightens with the voice, every 32 ms frame (voice-level.ts), so speaking
 * shows on screen within the owner's 0.2 s floor even before the words do.
 * Its style is written straight from the bus, at most once per animation frame.
 */
export function MicCaret() {
  const el = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let level = 0;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const s = el.current?.style;
      if (!s) return;
      s.transform = `scaleY(${(0.35 + 0.65 * level).toFixed(3)})`;
      s.opacity = (0.35 + 0.65 * level).toFixed(3);
    };
    const off = subscribeLevel((l) => {
      level = l;
      raf ||= requestAnimationFrame(paint);
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <span
      ref={el}
      data-testid="debug-chat-mic-caret"
      aria-hidden
      className="ms-0.5 inline-block h-[1.1em] w-[3px] origin-bottom rounded-full bg-current align-text-bottom"
      style={{ transform: "scaleY(0.35)", opacity: 0.35 }}
    />
  );
}
