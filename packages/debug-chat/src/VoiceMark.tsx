"use client";

/**
 * The tiny mark after a voice line the Mac verified as his voice (SpeakerTag
 * decision "me"; voiceprint.ts, docs/local-stt.md "Voiceprint"). Its own
 * glyph, a sound wave, not a ✓: a tick reads as "read" or "done" (owner,
 * 2026-11-11: "是已读还是已经处理？"), and the chat keeps ✓ for done and
 * answered. Its words (`label`) are the tooltip on hover and a bubble on a
 * tap or long press, so a phone can read them too.
 *
 * Its own module so the unit suite can load it without VoiceprintPanel.tsx
 * (the enrolment UI, covered in a browser by the voice QA, not here).
 */
import { useEffect, useRef, useState } from "react";

/** How long the voice mark's bubble stays up after a tap or long press. */
export const VOICE_TIP_MS = 1_500;

type Hide = { current: ReturnType<typeof setTimeout> | undefined };

/**
 * The bubble's clock: show it, and hide it `ms` later; another tap restarts
 * the clock instead of stacking a second, earlier hide.
 */
export function bubbleClock(setTip: (on: boolean) => void, hide: Hide, ms = VOICE_TIP_MS) {
  return () => {
    setTip(true);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setTip(false), ms);
  };
}

/**
 * The button's handlers. Both stop the event at the mark: the line behind it
 * opens its details on a tap, and a long press (which arrives as contextmenu)
 * must neither open those nor the browser's own menu.
 */
export function voiceMarkHandlers(show: () => void) {
  return {
    onClick(e: { stopPropagation(): void }) {
      e.stopPropagation();
      show();
    },
    onContextMenu(e: { preventDefault(): void; stopPropagation(): void }) {
      e.preventDefault();
      e.stopPropagation();
      show();
    },
  };
}

export function VoiceMark({ label, tipMs = VOICE_TIP_MS }: { label: string; tipMs?: number }) {
  const [tip, setTip] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hide.current), []);
  return (
    <button
      type="button"
      data-testid="debug-chat-voice-verified"
      title={label}
      aria-label={label}
      className="pointer-events-auto relative ms-1 inline-flex select-none items-center align-baseline leading-none [-webkit-touch-callout:none]"
      style={{ fontSize: "0.8em", color: "oklch(0.62 0.15 150)", opacity: 0.85, background: "transparent", border: 0, padding: 0 }}
      {...voiceMarkHandlers(bubbleClock(setTip, hide, tipMs))}
    >
      <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <path d="M3 6.5v3M6 4.5v7M9 3v10M12 5.5v5" />
      </svg>
      {tip && (
        // Physical `left-1/2` with the physical `-translate-x-1/2`: centred in
        // RTL too (logical `start-1/2` would pair right:50% with a leftward
        // shift and land the bubble a full width off).
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded px-1 fs-10 lk-halo"
        >
          {label}
        </span>
      )}
    </button>
  );
}
