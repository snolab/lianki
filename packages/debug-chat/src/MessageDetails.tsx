import {
  type MouseEvent,
  type KeyboardEvent,
  useId,
  useEffect,
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
import { readingsOf } from "./whisper-recheck";
import { hasVoiceDetails, voiceDetailRows } from "./voice-details";
import { latencyLines, voiceLatency } from "./latency";
import type { UiStrings } from "./ui-strings";

/** The details' voice rows' words (chat-ui-locales.ts). */
export type VoiceWords = Pick<
  ChatExtra,
  "voiceUsed" | "voiceUseThis" | "voicePinned" | "voiceUnpin" | "voiceClone"
>;
/** The words of a spoken line's three readings (chat-ui-locales.ts). */
export type ReadingWords = Pick<ChatExtra, "levelHeard" | "levelWhisper" | "levelPolished">;

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

/**
 * A spoken line's readings, one under another (whisper-recheck.ts readingsOf): what
 * the streaming STT heard, what Whisper heard re-reading the whole run, and the
 * polish after it. Nothing for a line Whisper never re-read.
 */
export function LineReadings({
  line,
  words,
}: {
  line: Pick<ChatMessage, "text" | "raw" | "edited" | "recheck">;
  words: ReadingWords;
}) {
  const r = readingsOf(line);
  if (!r) return null;
  const rows: [string, string, string][] = [
    ["heard", words.levelHeard, r.heard],
    ["whisper", words.levelWhisper.replace("{engine}", r.whisper.engine), r.whisper.text],
    ...(r.polished !== undefined
      ? ([["polished", words.levelPolished, r.polished]] as [string, string, string][])
      : []),
  ];
  return (
    <ol data-testid="debug-chat-message-readings" className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
      {rows.map(([level, label, text]) => (
        <li key={level} data-level={level}>
          <div className="fs-11 opacity-70">{label}</div>
          <div className="whitespace-pre-wrap break-words">{text}</div>
        </li>
      ))}
    </ol>
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

/** Only fields carried by this message; missing recognition or speaker metadata stays absent. */
export function VoiceDetailRows({ message, words, ui }: {
  message: ChatMessage;
  words: ChatExtra;
  ui: UiStrings;
}) {
  const rows = hasVoiceDetails(message) ? voiceDetailRows(message) : [];
  if (!rows.length) return null;
  const value = (key: string, v: string | number | boolean) => {
    if (key === "route") return v === "local" ? ui.latLocal : ui.latCloud;
    if (key === "speakerDecision") return v === "me" ? words.voiceDecisionMe : v === "other" ? words.voiceDecisionOther : words.voiceDecisionUnknown;
    if (key === "polishedAt" && typeof v === "number") return new Date(v).toLocaleString();
    if (key === "repeat") return words.voiceRepeatTrimmed;
    return typeof v === "boolean" ? ui.sttFallback : String(v);
  };
  return <dl data-testid="debug-chat-voice-details" className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1">
    {rows.map((row) => <div key={row.key} className="contents">
      <dt className="min-w-0 break-words opacity-70">{words[`voiceDetail${row.key[0]!.toUpperCase()}${row.key.slice(1)}` as keyof ChatExtra]}</dt>
      <dd data-field={row.key} className="m-0 min-w-0 break-words font-mono fs-11">{value(row.key, row.value)}</dd>
    </div>)}
  </dl>;
}

/** The existing measured latency timeline, matched by message id, never the latest unrelated line. */
function VoiceTimeline({ message, ui }: { message: ChatMessage; ui: UiStrings }) {
  const latency = voiceLatency();
  const [, changed] = useState(0);
  useEffect(() => latency.subscribe(() => changed((n) => n + 1)), [latency]);
  const open = latency.open();
  const record = open?.id === message.id ? open : latency.records().findLast((r) => r.id === message.id);
  if (!record && !message.timing) return null;
  const lines = latencyLines(record ?? { timing: message.timing! }, ui, message.stt?.route);
  if (!lines.speech && !lines.reply && !lines.total) return null;
  const line = (title: string, group?: { total: string; parts: [string, string][] }) => group && (
    <div className="tabular-nums">{title}: <strong>{group.total} s</strong>
      {group.parts.length > 0 && ` (${group.parts.map(([label, seconds]) => `${label} ${seconds}`).join(" · ")})`}
    </div>
  );
  return <div data-testid="debug-chat-voice-timeline" className="mt-2 break-words fs-11">
    {line(ui.latSpeechLine, lines.speech)}
    {line(ui.latReplyLine, lines.reply)}
    {lines.total && <div>{ui.latTotal}: <strong>{lines.total} s</strong></div>}
  </div>;
}

/** Message inspection never fetches or infers identity or recognition data. */
export function useMessageDetails(label: string, voiceWords?: VoiceWords & Partial<ReadingWords>, ui?: UiStrings, detailWords?: ChatExtra) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    message: ChatMessage;
    sender: string;
    anchor: DOMRect;
    voice?: boolean;
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
      // A tap on a link (or a field) is the link's: the browser follows it, the
      // details stay closed (owner, 2026-11-14 21:0x: "手机点不开这个链接，它显示的是消息详情").
      if (e.target instanceof Element && e.target.closest("a,input,textarea,select,button")) return;
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
          recheck: m.recheck,
        }).filter(([, value]) => value !== undefined),
      )
    : {};
  return {
    forMessage,
    id,
    openVoice: (message: ChatMessage, sender: string, anchor: DOMRect) => setSelection({ message, sender, anchor, voice: true }),
    popup:
      selection &&
      createPortal(
        <div
          ref={popup}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={selection.voice && detailWords ? detailWords.voiceDetails : label}
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
          <strong>{selection.voice && detailWords ? detailWords.voiceDetails : label}</strong>
          <div>{selection.sender}</div>
          {at && (
            <time dateTime={at.toISOString()}>
              {at.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}
            </time>
          )}
          {m && ui && detailWords && <VoiceDetailRows message={m} words={detailWords} ui={ui} />}
          {m && ui && <VoiceTimeline message={m} ui={ui} />}
          {voiceWords && m && typeof m.id === "string" && (
            <LineVoice lineId={m.id} words={voiceWords} />
          )}
          {m && voiceWords?.levelHeard && voiceWords.levelWhisper && voiceWords.levelPolished && (
            <LineReadings
              line={m}
              words={{
                levelHeard: voiceWords.levelHeard,
                levelWhisper: voiceWords.levelWhisper,
                levelPolished: voiceWords.levelPolished,
              }}
            />
          )}
          <pre className="m-0 mt-2 whitespace-pre-wrap break-words font-mono fs-10">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </div>,
        document.body,
      ),
  };
}
