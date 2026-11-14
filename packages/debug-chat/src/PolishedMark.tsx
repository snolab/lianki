/**
 * The small muted mark after a voice line the agent polished
 * (docs/dev-debug-widget.md, "Agent edits of voice messages"). Its tooltip
 * is `label` ("Polished"). With `rawText`, a tap or keyboard activation
 * opens the original in a popover without changing the message body.
 * With `by`, the lower-right badge and the label identify the editor.
 * Legacy summary marks can still toggle their expanded raw view.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { chatExtra } from "./chat-ui-locales";
import { agentAvatar } from "./LaneMark";
import { LANES, laneOf } from "./voices";

/** Old messages without an editor keep their original mark and label. */
export function polishedEditor(by: string | undefined, autoName: string) {
  const name = by?.trim();
  if (!name) return null;
  if (name === "auto") return { name: autoName, auto: true, lane: null };
  const lane = laneOf({ text: name }).lane ?? laneOf({ text: `【${name}】` }).lane;
  return { name: (lane && LANES[lane].name) || name, auto: false, lane };
}

/** A press this long on touch shows the tooltip instead of toggling. */
export const LONG_PRESS_MS = 500;
/** How long the long-press tooltip stays up. */
const TIP_MS = 1_500;

export function PolishedMark({
  icon,
  label,
  showRaw,
  onToggle,
  rawText,
  by,
}: {
  icon: ReactNode;
  label: string;
  showRaw: boolean;
  onToggle: () => void;
  rawText?: string;
  by?: string;
}) {
  const words = chatExtra();
  const editor = polishedEditor(by, words.polishedAuto);
  const editorLabel = editor ? words.polishedBy.replace("{name}", editor.name) : label;
  const rawTipId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [rawTipOpen, setRawTipOpen] = useState(false);
  const rawPreview = rawText !== undefined;
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
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="debug-chat-polished"
        data-raw={(!rawPreview && showRaw) || undefined}
        title={editorLabel}
        aria-label={editorLabel}
        aria-pressed={rawPreview ? undefined : showRaw}
        aria-expanded={rawPreview ? rawTipOpen : undefined}
        aria-controls={rawPreview ? rawTipId : undefined}
        aria-describedby={rawTipOpen ? rawTipId : undefined}
        popoverTarget={rawPreview ? rawTipId : undefined}
        className="pointer-events-auto relative ms-1 inline-flex select-none items-center align-baseline text-[0.85em] leading-none text-gray-500 [-webkit-touch-callout:none]"
        style={{ opacity: (rawPreview ? rawTipOpen : showRaw) ? 1 : 0.75 }}
        onPointerDown={(e) => {
          held.current = false;
          if (rawPreview || e.pointerType !== "touch") return;
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
        onKeyDown={(e) => {
          if (rawPreview && (e.key === "Enter" || e.key === " " || e.key === "Escape"))
            e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (rawPreview) return;
          if (held.current) {
            held.current = false;
            return;
          }
          onToggle();
        }}
      >
        {icon}
        {editor && (
          <span
            aria-hidden
            data-testid="debug-chat-polished-by"
            data-editor={editor.auto ? "auto" : editor.lane ?? "agent"}
            className="pointer-events-none absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center overflow-hidden rounded-full bg-[oklch(0.95_0.01_85)] text-[oklch(0.4_0.04_250)] ring-1 ring-[oklch(0.95_0.01_85)] dark:bg-[oklch(0.25_0.01_250)] dark:text-[oklch(0.86_0.02_250)] dark:ring-[oklch(0.25_0.01_250)]"
          >
            {editor.auto ? (
              <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5" />
                <path d="M10 12h4M12 10v4" />
              </svg>
            ) : agentAvatar({ name: editor.name, lane: editor.lane ?? undefined })}
          </span>
        )}
        {tip && (
          <span
            role="tooltip"
            className="pointer-events-none absolute start-1/2 bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded px-1 fs-10 lk-halo"
          >
            {editorLabel}
          </span>
        )}
      </button>
      {rawPreview && (
        <span
          id={rawTipId}
          popover="auto"
          role="tooltip"
          data-testid="debug-chat-raw-tip"
          onToggle={(e) => {
            const open = e.newState === "open";
            setRawTipOpen(open);
            if (!open || !trigger.current) return;
            const popup = e.currentTarget;
            const anchor = trigger.current.getBoundingClientRect();
            const box = popup.getBoundingClientRect();
            popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
            popup.style.top = `${Math.max(
              8,
              Math.min(
                anchor.top >= box.height + 8 ? anchor.top - box.height - 8 : anchor.bottom + 8,
                window.innerHeight - box.height - 8,
              ),
            )}px`;
          }}
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto fixed m-0 max-h-[50vh] max-w-[min(28rem,calc(100vw-1rem))] overflow-auto rounded-md border border-current/20 px-3 py-2 text-start fs-12 leading-relaxed whitespace-pre-wrap shadow-lg backdrop-blur-md"
          style={{
            inset: "auto",
            background: "oklch(from var(--background) l c h / 0.92)",
            color: "var(--foreground)",
          }}
        >
          {editor && <span className="mb-1 block font-medium">{editorLabel}</span>}
          {rawText}
        </span>
      )}
    </>
  );
}
