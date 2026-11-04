/**
 * A chat line's copy button (copy-line.ts): copies the line's plain text,
 * then shows a tick and "Copied" for a moment. Small and faint, so it sits
 * after the text without crowding it; never selected along with the text.
 */
import { useEffect, useState } from "react";
import { copyText } from "./copy-line";

const COPY =
  "M5.5 5.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-2.5M3 5.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5Z";
const TICK = "M3.5 8.5l3 3 6-7";
/** How long the tick stays (ms). */
export const COPIED_MS = 1500;

export function CopyLine({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  /** "Copy" (its tooltip and accessible label). */
  label: string;
  /** "Copied", shown and announced after a copy. */
  copiedLabel: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      data-testid="debug-chat-copy"
      data-copied={done || undefined}
      aria-label={done ? copiedLabel : label}
      title={done ? copiedLabel : label}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => ok && setDone(true));
      }}
      // A finger-sized target past its small glyph (the ::after), as the tree's copy button.
      className="pointer-events-auto relative ms-1 inline-flex select-none items-center border-0 bg-transparent p-0 align-[-0.1em] text-gray-500 opacity-60 after:absolute after:-inset-2 after:content-[''] hover:opacity-100 [-webkit-touch-callout:none]"
      style={done ? { color: "oklch(0.62 0.15 150)", opacity: 1 } : undefined}
    >
      <svg
        viewBox="0 0 16 16"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="inline-block shrink-0"
        aria-hidden
      >
        <path d={done ? TICK : COPY} />
      </svg>
      <span role="status" className="sr-only">
        {done ? copiedLabel : ""}
      </span>
    </button>
  );
}
