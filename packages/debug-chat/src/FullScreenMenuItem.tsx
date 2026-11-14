/**
 * The chat menu's Full screen row (docs/dev-debug-widget.md, "Full screen"):
 * a switch that shows both states, [ On | Off ], the current one filled seal
 * red (SealStamp; docs/design-principles.md, "A switch shows all its states").
 * While the agent changes it (ui-cue.ts), the row is outlined and pulses once
 * so he sees which switch moved.
 */
import { useEffect, useRef } from "react";
import { SealStamp } from "./SealStamp";
import { CUE_OUTLINE, pulseRow } from "./ui-cue";

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function FullScreenMenuItem({
  on,
  cue = false,
  label,
  onWord,
  offWord,
  onToggle,
}: {
  on: boolean;
  /** The agent is changing it: outlined, one pulse. */
  cue?: boolean;
  label: string;
  onWord: string;
  offWord: string;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (cue && ref.current) pulseRow(ref.current, reducedMotion());
  }, [cue]);
  return (
    <button
      ref={ref}
      type="button"
      role="menuitemcheckbox"
      data-testid="debug-menu-fullscreen"
      data-cue={cue || undefined}
      aria-checked={on}
      style={cue ? CUE_OUTLINE : undefined}
      onClick={onToggle}
      className="flex items-center gap-2 px-3 py-1.5 text-start"
    >
      <SealStamp on={on} onWord={onWord} offWord={offWord} />
      {label}
    </button>
  );
}
