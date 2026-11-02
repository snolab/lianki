/**
 * The /words voice mode's wiring (docs/voice-mode.md): a final transcript →
 * one of the study view's own actions, the ones the keys and the swipe
 * already use. Nothing here grades, moves or reads by itself: the study view
 * hands in `VoiceActions` built on its own `grade`, `undo`, focus and speech.
 *
 * Pure: unit/voice-commands.test.ts.
 */
import type { Rating } from "./schedule";
import { levelRating } from "./swipe";
import { type VoiceCommand, addressesAgent, isCardEcho, matchCommand } from "./voice-commands";

/** What the study view lends the voice mode. Each is the same path a key or a swipe takes. */
export type VoiceActions = {
  /** The previous (-1) or next (+1) card: the cursor on desktop, the focus on touch. */
  move(delta: -1 | 1): void;
  /** Grade the current card, and move on as a swipe does when it was ungraded. */
  grade(r: Rating): void;
  /** Show the current card's answer. */
  show(): void;
  /** Read the current card aloud again. */
  read(): void;
  /** Undo the last grade (Z). */
  undo(): void;
  /** Turn voice mode off. */
  exit(): void;
};

/** Each command, as the actions it runs. ←/→ are a one-level swipe (lib/words/swipe.ts levelRating). */
export const COMMAND_ACTIONS: Record<VoiceCommand, (a: VoiceActions) => void> = {
  next: (a) => a.move(1),
  prev: (a) => a.move(-1),
  left: (a) => a.grade(levelRating(-1) as Rating),
  right: (a) => a.grade(levelRating(1) as Rating),
  again: (a) => a.grade(1),
  hard: (a) => a.grade(2),
  good: (a) => a.grade(3),
  easy: (a) => a.grade(4),
  show: (a) => a.show(),
  read: (a) => a.read(),
  undo: (a) => a.undo(),
  exit: (a) => a.exit(),
};

/** The commands that need a card under the focus. */
const NEEDS_CARD: ReadonlySet<VoiceCommand> = new Set([
  "left",
  "right",
  "again",
  "hard",
  "good",
  "easy",
  "show",
  "read",
]);

export type VoiceOutcome =
  /** Ran: the confirmation shows the command. */
  | { kind: "done"; cmd: VoiceCommand; heard: string }
  /** Not a command: shown as heard, nothing done. */
  | { kind: "unknown"; heard: string }
  /** A command word that is also a card's own text (read aloud, or practised): nothing done. */
  | { kind: "echo"; cmd: VoiceCommand; heard: string }
  /** A command with no card to act on (the list is still loading): nothing done. */
  | { kind: "no-card"; cmd: VoiceCommand; heard: string }
  /** "Linky, …": for the agent; the chat gets it as before. */
  | { kind: "agent" };

export type VoiceContext = {
  actions: VoiceActions;
  /** The texts of the cards around the focus (word, reading, meaning), for the echo check. */
  cardTexts: readonly (string | undefined)[];
  /** There is a current card. */
  hasCard: boolean;
};

/** One final transcript, start to end: match it, check it, run it. */
export function handleUtterance(text: string, ctx: VoiceContext): VoiceOutcome {
  const heard = text.trim();
  if (addressesAgent(heard)) return { kind: "agent" };
  const m = matchCommand(heard);
  if (!m) return { kind: "unknown", heard };
  // Leaving voice mode is never blocked: it must always work.
  if (m.cmd !== "exit" && isCardEcho(heard, ctx.cardTexts))
    return { kind: "echo", cmd: m.cmd, heard };
  if (NEEDS_CARD.has(m.cmd) && !ctx.hasCard) return { kind: "no-card", cmd: m.cmd, heard };
  COMMAND_ACTIONS[m.cmd](ctx.actions);
  return { kind: "done", cmd: m.cmd, heard };
}

/** The tap's verdict on a transcript: every outcome but "agent" is kept from the chat. */
export const keepsTranscript = (o: VoiceOutcome) => o.kind !== "agent";
