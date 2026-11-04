/**
 * The voice in a background tab on a computer (owner 2026-11-04, "pc页面切走不要马上停语音").
 *
 * On a computer (a mouse or trackpad: the primary pointer is fine and can
 * hover) switching to another tab or window no longer stops anything: the
 * mic keeps listening and the reading keeps going until he stops it himself.
 * There is no grace period. While it runs in a tab he is not looking at, the
 * tab's title says so ("🎙 Lianki voice on · …"), besides the browser's own
 * mic indicator. On a phone nothing changes: hiding the page stops the
 * reading and keeps lines silent as before (the browser suspends background
 * audio there anyway).
 *
 * One voice per device: another Lianki tab turning its mic on takes the
 * voice over (debug-chat-tabs.ts `onTakeover`): this one turns its mic off and
 * stops reading, and shows no hint. A tab he focuses takes the reading over
 * from a hidden tab that reads with the mic off.
 *
 * Pure decisions here (unit/voice-bg.test.ts); the listeners are in voice.ts,
 * DebugChat.tsx, local-stt.ts and DebugEval.tsx.
 */

type Match = (q: string) => { matches: boolean };

/** A computer: the primary pointer is fine and can hover (mouse, trackpad). False without matchMedia. */
export function isDesktop(mm?: Match | null): boolean {
  const m = mm === undefined ? (typeof matchMedia === "function" ? matchMedia : null) : mm;
  if (!m) return false;
  try {
    return m("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}

/** Hiding the page stops the reading under way (phones only). */
export const hideStops = (desktop: boolean) => !desktop;

/** A line arriving now is kept silent because the page is hidden (phones only). */
export const hiddenSilences = (at: { hidden: boolean; desktop: boolean }) => at.hidden && !at.desktop;

/** What the voice session is doing that a hidden tab keeps going. */
export type Busy = { mic: boolean; speaking: boolean; queued: number };

/** The voice is running in this tab: the mic on, or something read or still to read. */
export const voiceBusy = (s: Busy) => s.mic || s.speaking || s.queued > 0;

/**
 * The hub socket stays open: the page is visible, or (a computer) the voice
 * runs here, so his spoken lines still go out and the replies still come in.
 */
export const keepHub = (at: { visible: boolean; desktop: boolean; busy: boolean }) =>
  at.visible || (at.desktop && at.busy);

/** The local STT socket may reopen now (the mic is on): visible, or on a computer. */
export const sttMayReopen = (at: { visible: boolean; desktop: boolean }) => at.visible || at.desktop;

/** Which glyph the title hint shows: the mic listening, or only the reading. */
export type HintKind = "mic" | "reading";

/**
 * The title hint: a computer, the voice running here, and the tab not the
 * one he is looking at (hidden, or the window unfocused). Null: no hint.
 */
export function titleHint(at: {
  desktop: boolean;
  visible: boolean;
  focused: boolean;
  voice: Busy;
}): HintKind | null {
  if (!at.desktop || (at.visible && at.focused) || !voiceBusy(at.voice)) return null;
  return at.voice.mic ? "mic" : "reading";
}

/** The glyph before the hint's words. */
export const HINT_GLYPH: Record<HintKind, string> = { mic: "🎙", reading: "🔊" };
/** Between the hint and the page's own title. */
export const HINT_SEP = " · ";

/** The page's own title, without a hint this module put before it. */
export function baseTitle(title: string, words: string): string {
  for (const g of Object.values(HINT_GLYPH)) {
    const p = `${g} ${words}${HINT_SEP}`;
    if (title.startsWith(p)) return title.slice(p.length);
  }
  return title;
}

/** The title to show: the page's own, with the hint before it when there is one. */
export function hintedTitle(title: string, words: string, kind: HintKind | null): string {
  const base = baseTitle(title, words);
  return kind ? `${HINT_GLYPH[kind]} ${words}${HINT_SEP}${base}` : base;
}

/**
 * Another tab took the voice over (debug-chat-tabs.ts): what this tab stops.
 * - "mic": another tab's mic came on: this mic goes off and the reading stops.
 * - "focus": he focused another tab: a reading here with the mic off stops
 *   if he is not looking at this one (the focused tab reads from now on).
 */
export function onTakeover(
  why: "mic" | "focus",
  here: { mic: boolean; looking: boolean },
): { micOff: boolean; stopReading: boolean } {
  if (why === "mic") return { micOff: here.mic, stopReading: true };
  return { micOff: false, stopReading: !here.mic && !here.looking };
}
