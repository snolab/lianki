"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ChatMessage, MAX_CHAT, type PairInfo, pickLang, pickVoice } from "@/lib/dev-eval";
import { Icon } from "./icons";

/** Typing pauses this long before the draft is sent. */
const DEBOUNCE_MS = 3_000;
/**
 * Dictation lands as one burst: more than BURST_CHARS arriving at once and
 * ending a sentence goes out at once, without waiting for the debounce.
 */
const BURST_CHARS = 10;
const ENDS_SENTENCE = /[。．.!?！？]$/;
const OPEN_KEY = "lk:debug-chat-open";
const SPEAK_KEY = "lk:debug-chat-speak";
const POS_KEY = "lk:debug-chat-pos";
/** The input and its grip: the page shows through at about half. */
const INPUT_BG = "color-mix(in oklch, var(--background) 55%, transparent)";

/**
 * Drag the box (by its header, or the collapsed pill) anywhere on screen: an
 * offset from its bottom-right home, kept on screen and remembered. A press
 * that moves under 5 px is still a click.
 */
function useDrag() {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const v = JSON.parse(read(POS_KEY) ?? "null") as { x: number; y: number } | null;
      return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  });
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const dragged = useRef(false);
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button:not([data-drag-handle])")) return;
      drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, moved: false };
      dragged.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      // Keep the whole box on screen: its rect at the start, moved by the delta.
      const box = (
        e.currentTarget.closest("[data-debug-chat]") as HTMLElement
      ).getBoundingClientRect();
      const left = box.left - (pos.x - d.x);
      const top = box.top - (pos.y - d.y);
      const x = d.x + Math.max(-left, Math.min(innerWidth - box.width - left, dx));
      const y = d.y + Math.max(-top, Math.min(innerHeight - box.height - top, dy));
      setPos({ x, y });
    },
    onPointerUp: () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.moved) return;
      dragged.current = true;
      setPos((p) => {
        write(POS_KEY, JSON.stringify(p));
        return p;
      });
    },
    onPointerCancel: () => (drag.current = null),
    style: { touchAction: "none" as const, cursor: "grab" },
  };
  /** The click that ends a drag is not a click. */
  const wasDrag = () => {
    const d = dragged.current;
    dragged.current = false;
    return d;
  };
  return { offset: { transform: `translate(${pos.x}px, ${pos.y}px)` }, handle, wasDrag };
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {}
};
const synth = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);

/** Whether agent replies are read aloud on this device (on unless turned off). */
const speechEnabled = () => read(SPEAK_KEY) !== "0";

/**
 * Read an agent reply aloud, after any still being read: the language comes
 * from its script (pickLang), with a matching installed voice if there is one.
 * Only ever called for a reply that arrived live, never for history.
 */
export function speakReply(text: string) {
  const s = synth();
  if (!s || !speechEnabled()) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = pickLang(text);
  const voice = pickVoice(s.getVoices(), u.lang);
  if (voice) u.voice = voice;
  s.speak(u);
}

/** Drop whatever is being read and queued — the owner has started typing. */
function cancelSpeech() {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}

let unlocked = false;
/** iOS speaks only after a user gesture: an empty utterance on the first one unlocks it. */
function unlockSpeech() {
  const s = synth();
  if (unlocked || !s) return;
  unlocked = true;
  s.speak(new SpeechSynthesisUtterance(""));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
function when(at: number) {
  const d = new Date(at);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day === today ? `${hm}:${pad(d.getSeconds())}` : `${day} ${hm}`;
}

/**
 * The owner ⇄ agent chat (docs/monitoring.md, "Chat with the agent"): a small
 * box at the bottom right of a debug-mode page that holds the debug socket.
 * Whatever is typed goes out DEBOUNCE_MS after the last keystroke (or at once
 * on Enter; Shift+Enter is a newline; or at once when dictation drops in more
 * than BURST_CHARS ending a sentence), never in the middle of an IME
 * composition. Translucent until touched or typed in. Replies appear in the log above and are read aloud (the
 * speaker toggle turns that off). Text only — nothing is rendered as HTML.
 */
export function DebugChat({
  live,
  listeners,
  messages,
  onSend,
  sessions = [],
  onEnd,
  inside,
}: {
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  onSend: (text: string) => boolean;
  /** Approved senders, listed in the grip's menu with an End button each. */
  sessions?: PairInfo[];
  onEnd?: (s: PairInfo) => void;
  /** Debug notices shown inside the box (the pairing prompt, "eval ran"). */
  inside?: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    const v = read(OPEN_KEY);
    return v === null ? !location.pathname.startsWith("/words") : v === "1";
  });
  const [speak, setSpeak] = useState(speechEnabled);
  const { offset, handle, wasDrag } = useDrag();
  /** The grip's menu (double tap): status, read-aloud, minimize. */
  const [menu, setMenu] = useState(false);
  const lastGripTap = useRef(0);
  const [draft, setDraft] = useState("");
  /** Re-keys the drain bar on each keystroke; 0 while nothing is waiting. */
  const [armed, setArmed] = useState(0);
  const [offline, setOffline] = useState(false);
  const [seen, setSeen] = useState(messages.length);
  const draftRef = useRef("");
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const log = useRef<HTMLOListElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  // The log is click-through, so it can't be swiped: a vertical swipe on the
  // input scrolls it instead (unless the draft itself is long enough to scroll).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    let y = 0;
    let swiping = false;
    const down = (e: TouchEvent) => {
      y = e.touches[0].clientY;
      swiping = false;
    };
    const move = (e: TouchEvent) => {
      const list = log.current;
      if (!list || el.scrollHeight > el.clientHeight + 1) return;
      const ny = e.touches[0].clientY;
      if (!swiping && Math.abs(ny - y) < 6) return;
      swiping = true;
      list.scrollTop -= ny - y;
      y = ny;
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
    };
  }, [open]);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  useEffect(() => {
    synth()?.getVoices(); // starts loading them, so the first reply finds one
    return () => clearTimeout(timer.current);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    setSeen(messages.length);
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages, open]);

  const submit = () => {
    clearTimeout(timer.current);
    setArmed(0);
    const text = draftRef.current.trim();
    if (!text) return;
    if (!sendRef.current(text)) return setOffline(true);
    setOffline(false);
    draftRef.current = "";
    settledLen.current = 0;
    setDraft("");
  };
  /** The draft's length when it last changed outside an IME composition. */
  const settledLen = useRef(0);
  /** The key going down is Shift+Enter: its line break stays a line break. */
  const shiftEnter = useRef(false);
  const arm = () => {
    clearTimeout(timer.current);
    if (!composing.current) {
      const text = draftRef.current;
      const burst = text.length - settledLen.current > BURST_CHARS;
      settledLen.current = text.length;
      if (burst && ENDS_SENTENCE.test(text.trim())) return submit();
    }
    if (composing.current || !draftRef.current.trim()) return setArmed(0);
    setArmed((n) => n + 1);
    timer.current = setTimeout(submit, DEBOUNCE_MS);
  };
  const toggle = (v: boolean) => {
    setOpen(v);
    write(OPEN_KEY, v ? "1" : "0");
  };
  const toggleSpeak = () => {
    const v = !speak;
    setSpeak(v);
    write(SPEAK_KEY, v ? "1" : "0");
    if (!v) synth()?.cancel();
  };

  const unread = messages.slice(seen).filter((m) => m.from === "agent").length;
  const dot = live ? "oklch(0.68 0.16 150)" : "oklch(0.62 0.02 70)";
  const status = offline
    ? "not connected — your draft is kept"
    : !live
      ? "reconnecting…"
      : listeners
        ? `agent listening (${listeners})`
        : "connected · no agent listening";

  if (!open)
    return (
      <button
        type="button"
        data-debug-chat
        data-drag-handle
        {...handle}
        style={{ ...handle.style, ...offset }}
        onClick={() => !wasDrag() && toggle(true)}
        onPointerDown={(e) => {
          unlockSpeech();
          handle.onPointerDown(e);
        }}
        aria-label={`Open chat with the agent${unread ? `, ${unread} new` : ""}`}
        className="fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex items-center lk-halo opacity-60 transition-opacity active:opacity-100 gap-1.5 px-3 py-1 text-xs text-gray-700 dark:text-gray-200"
      >
        <span className="size-2 rounded-full" style={{ background: dot }} />
        chat
        {unread > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 text-[10px] text-white">{unread}</span>
        )}
      </button>
    );

  return (
    <section
      data-debug-chat
      aria-label="Chat with the agent"
      onPointerDown={unlockSpeech}
      onKeyDown={unlockSpeech}
      style={offset}
      className="fixed right-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex w-[min(20rem,calc(100vw-1rem))] opacity-60 transition-opacity focus-within:opacity-100 active:opacity-100 pointer-events-none flex-col rounded-xl lk-halo text-xs text-gray-800 dark:text-gray-100"
    >
      <ol ref={log} className="max-h-[30vh] min-h-12 space-y-0.5 overflow-y-auto px-2 py-1.5">
        {messages.length === 0 && (
          <li className="text-gray-500">Type here; it is sent 3 s after you stop.</li>
        )}
        {/* A game-style log: one line per message, "name: text", no bubbles. */}
        {messages.map((m) => (
          // The time only on hover (long press on a phone): name and text are the line.
          <li
            key={m.id}
            title={when(m.at)}
            className="whitespace-pre-wrap break-words leading-snug"
          >
            <span
              className="me-1 font-medium"
              style={{
                color: m.from === "owner" ? "oklch(0.55 0.13 250)" : "oklch(0.55 0.14 150)",
              }}
            >
              {m.from === "owner" ? "you" : m.label || "agent"}:
            </span>
            {m.text}
          </li>
        ))}
      </ol>
      {inside && (
        <div className="pointer-events-auto flex flex-col gap-1 px-1 pb-1 text-xs">{inside}</div>
      )}
      {/* The log above is click-through: taps reach the page under it. Only the
          grip and the input take pointer events. */}
      <div className="relative flex items-stretch gap-1">
        {/* No title bar: the grip drags the box, and a double tap on it opens
            the menu (status, read-aloud, minimize). Its dot is the connection. */}
        <button
          type="button"
          data-drag-handle
          aria-label="Drag the chat box; double tap for its menu"
          aria-expanded={menu}
          title={status}
          {...handle}
          onClick={(e) => {
            if (wasDrag()) return;
            const second = e.timeStamp - lastGripTap.current < 350;
            lastGripTap.current = second ? 0 : e.timeStamp;
            if (second) setMenu((m) => !m);
          }}
          style={{ ...handle.style, background: INPUT_BG }}
          className="pointer-events-auto relative shrink-0 rounded-lg border border-current/25 px-1.5 text-base leading-none text-gray-500"
        >
          ⠿
          <span
            aria-hidden
            className="absolute end-0.5 top-0.5 size-1.5 rounded-full"
            style={{ background: dot }}
          />
        </button>
        {menu && (
          <div
            role="menu"
            data-debug-chat-menu
            style={{ background: INPUT_BG }}
            className="pointer-events-auto absolute bottom-full start-0 mb-1 flex min-w-48 flex-col rounded-lg border border-current/25 py-1 text-xs backdrop-blur"
          >
            <span className="px-3 py-1 text-gray-500" aria-live="polite">
              {status}
            </span>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={speak}
              onClick={toggleSpeak}
              className="flex items-center gap-2 px-3 py-1.5 text-start"
            >
              <Icon name="speakerHigh" weight={speak ? "fill" : "regular"} />
              {speak ? "Replies read aloud" : "Replies silent"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                toggle(false);
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-start"
            >
              <span className="w-[1em] text-center">–</span>
              Minimize
            </button>
            {sessions.map((x) => (
              <div key={x.pair} className="flex items-center gap-2 px-3 py-1 text-gray-500">
                <span className="min-w-0 flex-1 truncate">
                  {x.scope === "chat" ? "chat" : "eval"}: {x.label} · {x.code}
                </span>
                <button type="button" onClick={() => onEnd?.(x)} className="underline">
                  End
                </button>
              </div>
            ))}
          </div>
        )}
        {armed > 0 && (
          <div
            key={armed}
            aria-hidden
            className="lk-drain absolute inset-x-0 top-0 h-0.5 bg-blue-600/60"
          />
        )}
        <div className="relative flex min-w-0 flex-1">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            maxLength={MAX_CHAT}
            placeholder="Message the agent…"
            aria-label="Message the agent"
            onChange={(e) => {
              draftRef.current = e.target.value;
              setDraft(e.target.value);
              setOffline(false);
              cancelSpeech();
              arm();
            }}
            onCompositionStart={() => {
              composing.current = true;
              clearTimeout(timer.current);
              setArmed(0);
            }}
            onCompositionEnd={() => {
              composing.current = false;
              arm();
            }}
            // Android's keyboards report every key as 229, so Enter never
            // reaches onKeyDown as "Enter": the line break itself is the cue.
            onBeforeInput={(e) => {
              const type = (e.nativeEvent as InputEvent).inputType;
              if (type !== "insertLineBreak" && type !== "insertParagraph") return;
              if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
              if (shiftEnter.current) return; // Shift+Enter: a newline, as on desktop
              e.preventDefault();
              submit();
            }}
            onKeyDown={(e) => {
              shiftEnter.current = e.key === "Enter" && e.shiftKey;
              if (e.key !== "Enter" || e.shiftKey) return;
              // Enter that confirms an IME candidate (Safari reports it as 229
              // after compositionend) must not send.
              if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
              e.preventDefault();
              submit();
            }}
            style={{ background: INPUT_BG }}
            className="pointer-events-auto block min-w-0 flex-1 resize-none pe-6 rounded-lg border border-current/25 px-2 py-1.5 text-sm outline-none placeholder:text-gray-400"
          />
        </div>
      </div>
    </section>
  );
}
