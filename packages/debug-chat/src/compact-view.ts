/**
 * Compact mode (owner, 2026-11-01: "相当于最小化模式或者只显示最后一条消息",
 * "让他减少干扰"): for mic input. While the input does not have the focus,
 * the open chat shows only its last message, as one short line with the
 * avatar, over the bar; the mic and the live transcript stay as they are.
 * A tap on the input or on that line brings the whole chat back, and it
 * folds again a short while after he stops using it.
 *
 * A per-device setting, off by default (ui-store.ts `chatPrefs`,
 * `lk:pref:chat-view`): he turns it on where he wants it, in the chat's menu.
 *
 * The rules are pure (unit/chat-compact.test.ts); DebugChat.tsx keeps one
 * timer for the next fold, re-armed by events: nothing polls.
 */
import type { AskAnswer, Ask } from "./ask";
import { askState } from "./ask";

/** After the input loses the focus, the whole chat stays this long. */
export const COMPACT_BLUR_MS = 1_500;
/** After a tap on the compact line (to read the chat), this long. */
export const COMPACT_PEEK_MS = 8_000;
/** After the last scroll or touch in the log, this long. */
export const COMPACT_SCROLL_MS = 3_000;
/** At most this many open ask cards are kept in full in compact mode. */
export const COMPACT_ASKS = 2;

/** What decides whether the open chat is compact now. */
export type CompactInput = {
  /** The setting (this device). */
  pref: boolean;
  /** The chat is open (minimized has its own floating lines). */
  open: boolean;
  /** Shown in full by an action (focus, a tap on the line, a drag), until it folds. */
  expanded: boolean;
  /** The input has the focus. */
  typing: boolean;
  /** The state tree has the log's place: it stays. */
  tree: boolean;
  /** The full-screen log (a drag) is up. */
  fullLog: boolean;
};

/** The open chat shows only its last message. */
export const isCompact = (s: CompactInput) =>
  s.pref && s.open && !s.expanded && !s.typing && !s.tree && !s.fullLog;

/** What decides when the whole chat folds back to compact. */
export type FoldInput = {
  pref: boolean;
  open: boolean;
  expanded: boolean;
  typing: boolean;
  /** The log is scrolled up: he is reading older lines. */
  scrolledUp: boolean;
  /** The tree, the menu or the full-screen log is up. */
  busy: boolean;
  /** Folding waits until then (ms epoch): the latest of every hold. */
  holdUntil: number;
  now: number;
};

/**
 * When to fold: "now", in some ms (a timer then asks again), or never for
 * now (null: an event will ask again, e.g. the blur or the scroll back down).
 */
export function foldIn(s: FoldInput): "now" | number | null {
  if (!s.pref || !s.open || !s.expanded) return null;
  // Typing, reading older lines, or a panel or drag in front: never mid-use.
  if (s.typing || s.scrolledUp || s.busy) return null;
  const wait = s.holdUntil - s.now;
  return wait > 0 ? wait : "now";
}

/** A hold that only ever moves later. */
export const holdAtLeast = (until: number, now: number, ms: number) => Math.max(until, now + ms);

type Line = { id: string; ask?: Ask; answer?: AskAnswer };

/**
 * What the compact view shows: the open ask cards (they need a tap, so they
 * stay in full; the newest COMPACT_ASKS), then the last message. The last
 * message is the line itself even when it is an ask.
 */
export function compactLines<T extends Line>(
  messages: readonly T[],
  now: number,
): { asks: T[]; last: T | null } {
  const last = messages.at(-1) ?? null;
  const asks = messages
    .filter((m) => m !== last && m.ask && askState(m, now) === "open")
    .slice(-COMPACT_ASKS);
  return { asks, last };
}
