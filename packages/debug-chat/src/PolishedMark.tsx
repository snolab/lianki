/**
 * The small muted mark after a voice line the agent polished
 * (docs/dev-debug-widget.md, "Agent edits of voice messages"). Its tooltip
 * is `label` ("Polished"): `title` on hover, and a long press on touch shows
 * it in a bubble without toggling. A tap toggles the line between the
 * polished text and the raw STT text.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";

/** A press this long on touch shows the tooltip instead of toggling. */
export const LONG_PRESS_MS = 500;
/** How long the long-press tooltip stays up. */
const TIP_MS = 1_500;

export function PolishedMark({
  icon,
  label,
  showRaw,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  showRaw: boolean;
  onToggle: () => void;
}) {
  const [tip, setTip] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The long press fired: the click that ends it does not toggle. */
  const held = useRef(false);
  useEffect(
    () => () => {
      clearTimeout(press.current);
      clearTimeout(hide.current);
    },
    [],
  );
  const cancel = () => clearTimeout(press.current);
  return (
    <button
      type="button"
      data-testid="debug-chat-polished"
      data-raw={showRaw || undefined}
      title={label}
      aria-label={label}
      aria-pressed={showRaw}
      className="pointer-events-auto relative ms-1 inline-flex select-none items-center align-baseline text-[0.85em] leading-none text-gray-500 [-webkit-touch-callout:none]"
      style={{ opacity: showRaw ? 1 : 0.75 }}
      onPointerDown={(e) => {
        held.current = false;
        if (e.pointerType !== "touch") return;
        cancel();
        press.current = setTimeout(() => {
          held.current = true;
          setTip(true);
          clearTimeout(hide.current);
          hide.current = setTimeout(() => setTip(false), TIP_MS);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        if (held.current) {
          held.current = false;
          return;
        }
        onToggle();
      }}
    >
      {icon}
      {tip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute start-1/2 bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded px-1 text-[10px] lk-halo"
        >
          {label}
        </span>
      )}
    </button>
  );
}
