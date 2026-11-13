import {
  type MouseEvent,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { ChatExtra } from "./chat-ui-locales";
import {
  type HeardVoice,
  heardFor,
  heardVersion,
  pinLocalVoice,
  pinnedLocalVoice,
  subscribeHeard,
} from "./voice-heard";
import type { ChatMessage } from "./wire";
import { CLONE_VOICE_NAME } from "./polish-readback";

/** The details' voice rows' words (chat-ui-locales.ts). */
export type VoiceWords = Pick<
  ChatExtra,
  "voiceUsed" | "voiceUseThis" | "voicePinned" | "voiceUnpin" | "voiceClone"
>;

const SEAL = "oklch(0.6 0.11 22.3)";

/**
 * Which voice read the line on this device (voice-heard.ts), one row per
 * voice. A voice the neko rotation picked offers "Use this voice" (pin it on
 * this device); while one is pinned, the pin and "Unpin (rotate)" are shown.
 */
export function HeardVoiceRows({
  heard,
  pinned,
  words,
  onPin,
}: {
  heard: readonly HeardVoice[];
  pinned: string | null;
  words: VoiceWords;
  onPin: (name: string | null) => void;
}) {
  if (!heard.length) return null;
  const cycled = heard.some((v) => v.cycle);
  const btn =
    "rounded border px-1.5 py-0.5 fs-11 leading-tight hover:bg-current/10 focus-visible:outline";
  return (
    <div data-testid="debug-chat-message-voice" className="mt-1 flex flex-col gap-1">
      {heard.map((v) => (
        <div key={v.name} className="flex flex-wrap items-center gap-2">
          <span data-voice={v.name}>
            {/* His own cloned voice (polish-readback.ts) in words, not its id. */}
            {v.name === CLONE_VOICE_NAME && words.voiceClone
              ? words.voiceClone
              : words.voiceUsed.replace("{name}", v.name)}
          </span>
          {v.cycle && v.name !== pinned && (
            <button
              type="button"
              data-testid="debug-chat-voice-pin"
              className={btn}
              style={{ borderColor: SEAL, color: SEAL }}
              onClick={() => onPin(v.name)}
            >
              {words.voiceUseThis}
            </button>
          )}
        </div>
      ))}
      {cycled && pinned && (
        <div className="flex flex-wrap items-center gap-2" data-pinned={pinned}>
          <strong style={{ color: SEAL }}>{words.voicePinned.replace("{name}", pinned)}</strong>
          <button
            type="button"
            data-testid="debug-chat-voice-unpin"
            className={`${btn} border-current/40 text-gray-600 dark:text-gray-300`}
            onClick={() => onPin(null)}
          >
            {words.voiceUnpin}
          </button>
        </div>
      )}
    </div>
  );
}

/** HeardVoiceRows for a line, kept in step with new reads and the pin. */
function LineVoice({ lineId, words }: { lineId: string; words: VoiceWords }) {
  useSyncExternalStore(subscribeHeard, heardVersion, heardVersion);
  return (
    <HeardVoiceRows
      heard={heardFor(lineId)}
      pinned={pinnedLocalVoice()}
      words={words}
      onPin={pinLocalVoice}
    />
  );
}

/** Message inspection never fetches or infers identity or recognition data. */
export function useMessageDetails(label: string, voiceWords?: VoiceWords) {
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
  /** A text selection inside this line (a selection elsewhere on the page must not block it). */
  const selectingIn = (el: Element) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString()) return false;
    return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
  };
  const forMessage = (message: ChatMessage, sender: string) => {
    const open = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const control = target.closest(
        "button,a,input,textarea,select,[contenteditable=true],[role=button]",
      );
      if (control && control !== e.currentTarget) return;
      if (selectingIn(e.currentTarget)) return;
      // On a touch screen a single tap is for reading the line; the details
      // (JSON) open on a double tap (owner, 2026-11-14 "双击才显示这种 JSON 的消息详情").
      // A mouse click still opens them (a double click there selects a word).
      const kind = "nativeEvent" in e ? (e.nativeEvent as PointerEvent).pointerType : undefined;
      const touch =
        kind === "touch" ||
        (!kind && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
      if (touch && e.type === "click" && (e as MouseEvent<HTMLElement>).detail < 2) return;
      e.stopPropagation();
      setSelection({ message, sender, anchor: e.currentTarget.getBoundingClientRect() });
    };
    return {
      tabIndex: 0,
      "aria-haspopup": "dialog" as const,
      "aria-controls": id,
      onClick: open,
      // Right-click opens the details too (owner, 2026-11-14: "我想用右键就能打开"); the
      // browser's own menu stays for selected text.
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        if (selectingIn(e.currentTarget)) return;
        // Only a link or a field keeps the browser's menu; a line wrapped in a
        // role=button (tap to read) still opens its details.
        if (e.target instanceof Element && e.target.closest("a,input,textarea,select,[contenteditable=true]")) return;
        e.preventDefault();
        e.stopPropagation();
        setSelection({ message, sender, anchor: e.currentTarget.getBoundingClientRect() });
      },
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
          {voiceWords && m && typeof m.id === "string" && (
            <LineVoice lineId={m.id} words={voiceWords} />
          )}
          <pre className="m-0 mt-2 whitespace-pre-wrap break-words font-mono fs-10">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </div>,
        document.body,
      ),
  };
}
