import {
  type MouseEvent,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ChatMessage } from "./wire";

/** Message inspection never fetches or infers identity or recognition data. */
export function useMessageDetails(label: string) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    message: ChatMessage;
    sender: string;
    anchor: DOMRect;
  } | null>(null);
  useLayoutEffect(() => {
    if (!selection || !popup.current) return;
    const el = popup.current;
    el.showPopover();
    const box = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(selection.anchor.left, innerWidth - box.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(selection.anchor.bottom + 8, innerHeight - box.height - 8))}px`;
  }, [selection]);
  const forMessage = (message: ChatMessage, sender: string) => {
    const open = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const control = target.closest(
        "button,a,input,textarea,select,[contenteditable=true],[role=button]",
      );
      if (control && control !== e.currentTarget) return;
      if (window.getSelection()?.toString()) return;
      e.stopPropagation();
      setSelection({ message, sender, anchor: e.currentTarget.getBoundingClientRect() });
    };
    return {
      tabIndex: 0,
      "aria-haspopup": "dialog" as const,
      "aria-controls": id,
      onClick: open,
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        open(e);
      },
    };
  };
  const m = selection?.message;
  const at = m && Number.isFinite(new Date(m.at).getTime()) ? new Date(m.at) : undefined;
  // Field names are wire metadata, not translated prose. Absent fields stay absent.
  const metadata = m
    ? Object.fromEntries(
        Object.entries({
          id: m.id,
          from: m.from,
          sender: m.sender,
          source: m.source,
          lane: m.lane,
          agentId: m.agentId,
          stt: m.stt,
          speaker: m.speaker,
          timing: m.timing,
          edited: m.edited,
          summary: m.summary,
          passage: m.passage,
        }).filter(([, value]) => value !== undefined),
      )
    : {};
  return {
    forMessage,
    popup:
      selection &&
      createPortal(
        <div
          ref={popup}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={label}
          data-testid="debug-chat-message-details"
          onToggle={(e) => {
            if (e.newState === "closed") setSelection(null);
          }}
          className="pointer-events-auto fixed m-0 max-h-[60vh] max-w-[min(28rem,calc(100vw-1rem))] overflow-auto rounded-md border border-current/20 px-3 py-2 text-start fs-12 leading-relaxed shadow-lg backdrop-blur-md"
          style={{
            inset: "auto",
            background: "oklch(from var(--background) l c h / 0.96)",
            color: "var(--foreground)",
          }}
        >
          <strong>{label}</strong>
          <div>{selection.sender}</div>
          {at && (
            <time dateTime={at.toISOString()}>
              {at.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}
            </time>
          )}
          <pre className="m-0 mt-2 whitespace-pre-wrap break-words font-mono fs-10">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </div>,
        document.body,
      ),
  };
}
