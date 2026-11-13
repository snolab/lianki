/**
 * Polish read-back (owner, 2026-11-14 02:40 JST): after an agent polished one
 * of his voice lines (docs/dev-debug-widget.md, "Agent edits of voice
 * messages"), the polished text is read back to him once, in his own cloned
 * voice, through Li's one read-aloud queue (voice.ts) — so the talk-over
 * pause, the read-aloud switch and the tab that reads all apply as to any
 * agent line.
 *
 * - Flag `voice.polish-readback` (lib/flags.ts, audience owner): the root
 *   layout hands it, with the timeout (config `voice.cloneTimeoutMs`), to
 *   DebugEval, which sets it here (`setPolishReadback`), on globalThis, so a
 *   hot-loaded chat and the deployed page agree.
 * - The clone server is a **device** setting, `lk:agent-clone-tts`
 *   (docs/prefs-sync.md): a tailnet URL on his Mac, like `lk:agent-local-tts`.
 *   Absent: DEFAULT_CLONE_TTS_BASE; "off": no read-back on this device.
 * - Fires on the polish event only (`readbackText`): his own spoken line
 *   (`source: "stt"`) going from raw (or merged, unpolished) to an agent's
 *   polish or polished passage. Never on a line's first arrival, a merge, a
 *   summary or an undo, and never twice for one line id (kept in memory).
 * - A clone that fails or times out is skipped silently (voice.ts logs it):
 *   never another voice in its place.
 *
 * Pure apart from the globalThis store; tested in unit/polish-readback.test.ts.
 */
import { MERGE_BY, UNMERGE_BY } from "./voice-merge";
import type { ChatMessage, EditMark, EditedEvent } from "./wire";

export const POLISH_READBACK_FLAG = "voice.polish-readback";
/** The clone server's base URL on this device (absent: the default; "off": none). */
export const CLONE_TTS_KEY = "lk:agent-clone-tts";
export const DEFAULT_CLONE_TTS_BASE = "https://taku.onca-tint.ts.net/lianki-clone-tts";
/** A clip not back in this long is skipped (config `voice.cloneTimeoutMs` overrides it). */
export const DEFAULT_CLONE_TIMEOUT_MS = 20_000;
/** The heard voice's name (voice-heard.ts; the line's details show it in words). */
export const CLONE_VOICE_NAME = "clone:owner";
/** Line ids remembered as read back (oldest dropped first). */
export const READBACK_KEEP = 200;

type Store = {
  on: boolean;
  timeoutMs: number;
  /** Lines already handled: never again. Id → the text queued ("" when it was not). */
  read: Map<string, string>;
};
const store = (): Store => {
  const g = globalThis as { __lkPolishReadback?: Store };
  return (g.__lkPolishReadback ??= {
    on: false,
    timeoutMs: DEFAULT_CLONE_TIMEOUT_MS,
    read: new Map(),
  });
};

/** From the root layout, through DebugEval: the flag, and the timeout. Absent: off. */
export function setPolishReadback(c?: { on: boolean; timeoutMs?: number } | null) {
  const s = store();
  s.on = !!c?.on;
  const ms = c?.timeoutMs;
  s.timeoutMs = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_CLONE_TIMEOUT_MS;
}
export const polishReadbackOn = (): boolean => store().on;
export const cloneTimeoutMs = (): number => store().timeoutMs;

const readLocal = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/** This device's clone server, without a trailing slash; null when it is "off". */
export function cloneTtsBase(read: (k: string) => string | null = readLocal): string | null {
  const v = read(CLONE_TTS_KEY)?.trim();
  if (v === "off") return null;
  return (v || DEFAULT_CLONE_TTS_BASE).replace(/\/+$/, "");
}

/** One sentence's clip from the clone server (GET …/tts?text= → audio/wav). */
export const cloneTtsUrl = (base: string, text: string) =>
  `${base.replace(/\/+$/, "")}/tts?text=${encodeURIComponent(text)}`;

/** An agent's polish (not a merge's or an undo's mark). */
export const isAgentPolish = (e: EditMark | undefined): boolean =>
  !!e && e.by !== MERGE_BY && e.by !== UNMERGE_BY;

/**
 * The text to read back for an edit, or null. `prev` is the line as the page
 * had it before the edit (absent: the page never had it — not his to hear).
 */
export function readbackText(
  prev: ChatMessage | undefined,
  e: Omit<EditedEvent, "type">,
): string | null {
  if (!prev || prev.id !== e.id || (prev.thread ?? "owner") !== e.thread) return null;
  // Only what he said himself, into the mic.
  if (prev.from !== "owner" || prev.source !== "stt") return null;
  // A summary is not his words; an undo or a merge is not a polish.
  if (e.summary || e.split || e.restored || e.merged || prev.summary) return null;
  if (!isAgentPolish(e.edited)) return null;
  // Already polished before: a repeat edit, not the raw → polished change.
  if (isAgentPolish(prev.edited) && prev.raw !== undefined) return null;
  const text = e.text.trim();
  return text ? text : null;
}

/** The text read back for a line, if it was (the chat's read-progress mirror claims it). */
export const readbackOf = (id: string): string | undefined => store().read.get(id) || undefined;

/** Forget every line (tests). */
export function clearReadback() {
  store().read.clear();
}

/**
 * The polish event: queue its read-back once, if it is one (readbackText), the
 * flag is on and this device has a clone server. `speaker`: this tab is the
 * one that reads (debug-chat-tabs.ts). True when the voice queued it.
 */
export function polishReadback(
  prev: ChatMessage | undefined,
  e: Omit<EditedEvent, "type">,
  d: {
    reply: (text: string, meta: { id: string }, how: { pick: { kind: "clone" } }) => boolean;
    speaker?: () => boolean;
    on?: () => boolean;
    base?: () => string | null;
    log?: (ev: Record<string, unknown>) => void;
  },
): boolean {
  if (!(d.on ?? polishReadbackOn)()) return false;
  const s = store();
  if (s.read.has(e.id)) return false;
  const text = readbackText(prev, e);
  if (!text) return false;
  // Handled from here on, read or not: one chance per line, the polish event.
  s.read.set(e.id, "");
  while (s.read.size > READBACK_KEEP) s.read.delete(s.read.keys().next().value as string);
  const log = d.log ?? (() => {});
  if (!(d.base ?? (() => cloneTtsBase()))()) {
    log({ ev: "polish-readback", skip: "off" });
    return false;
  }
  if (!(d.speaker?.() ?? true)) {
    log({ ev: "polish-readback", skip: "other-tab" });
    return false;
  }
  const queued = d.reply(text, { id: e.id }, { pick: { kind: "clone" } });
  if (queued) s.read.set(e.id, text);
  log({ ev: "polish-readback", chars: text.length, queued });
  return queued;
}
