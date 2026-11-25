/**
 * A voice-fill patch (widget-fill.ts) as a small chip under the agent's line:
 * "Filled 2 fields · show form". Rendering it applies the patch once; a tap
 * scrolls to the form and flashes the fields it filled.
 */
import { useEffect } from "react";
import { fillStore, parseFill, type FillStore } from "./widget-fill";
import type { WidgetHost } from "./MessageWidget";

const INK = "light-dark(oklch(0.46 0.187 22.3), oklch(0.8 0.132 22.3))";

export function FillChip({
  spec,
  patchId,
  host,
  store = fillStore,
}: {
  spec: string;
  /** The patch line's own id: a patch is applied once, however often it renders. */
  patchId: string;
  host: WidgetHost;
  store?: FillStore;
}) {
  const patch = parseFill(spec);
  useEffect(() => {
    if (patch) store.apply(patchId, patch);
    // The spec is the patch; one apply per patch line.
  }, [patchId, spec]);
  if (!patch) return null;
  const n = Object.keys(patch.fields).length;
  return (
    <button
      type="button"
      data-testid="debug-chat-fill-chip"
      className="pointer-events-auto my-1 inline-flex items-center gap-1 rounded-full border px-3 py-0.5 fs-12 font-semibold"
      style={{ borderColor: INK, color: INK }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const form = document.querySelector(`[data-widget-line="${CSS.escape(patch.line)}"]`);
        form?.scrollIntoView({ block: "center", behavior: "smooth" });
        store.flash(patch.line);
      }}
    >
      {host.labels.filled.replace("{n}", String(n))}
    </button>
  );
}
