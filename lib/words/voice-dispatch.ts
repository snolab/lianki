/**
 * The voice commands' wiring (docs/voice-mode.md): a final transcript → one
 * of the current screen's own actions, the ones its keys, buttons and swipe
 * already use. Nothing here grades, moves or reads by itself: each screen
 * registers the `VoiceActions` it has (/words all of them, /review the
 * grades), built on its own functions. A command the screen did not register
 * does nothing, and that line goes to the chat like any other (`voiceTap`).
 *
 * Pure: unit/voice-commands.test.ts.
 */
import type { Rating } from "./schedule";
import { levelRating } from "./swipe";
import { type VoiceCommand, addressesAgent, isCardEcho, matchCommand } from "./voice-commands";

/** What a screen lends the voice mode. Each is the same path a key or a swipe takes. */
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

/** Each command, as the action it needs from the screen. */
const ACTION_OF: Record<VoiceCommand, keyof VoiceActions> = {
  next: "move",
  prev: "move",
  left: "grade",
  right: "grade",
  again: "grade",
  hard: "grade",
  good: "grade",
  easy: "grade",
  show: "show",
  read: "read",
  undo: "undo",
  exit: "exit",
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
  /** Not a command (a sentence, a question), or one this screen has no action for: nothing done. */
  | { kind: "unknown"; heard: string }
  /** A command word that is also a card's own text (read aloud, or practised): nothing done. */
  | { kind: "echo"; cmd: VoiceCommand; heard: string }
  /** A command with no card to act on (the list is still loading): nothing done. */
  | { kind: "no-card"; cmd: VoiceCommand; heard: string }
  /** "Linky, …": for the agent only, so no command runs. */
  | { kind: "agent" };

export type VoiceContext = {
  /** What the current screen handles; a command it leaves out does nothing. */
  actions: Partial<VoiceActions>;
  /** The texts of the cards around the focus (word, reading, meaning), for the echo check. */
  cardTexts: readonly (string | undefined)[];
  /** What the focused card (and the one before it) reads aloud: word, meaning, example. */
  spoken?: readonly (string | undefined)[];
  /** There is a current card. */
  hasCard: boolean;
};

/** One final transcript, start to end: match it, check it, run it. */
export function handleUtterance(text: string, ctx: VoiceContext): VoiceOutcome {
  const heard = text.trim();
  if (addressesAgent(heard)) return { kind: "agent" };
  const m = matchCommand(heard);
  if (!m || !ctx.actions[ACTION_OF[m.cmd]]) return { kind: "unknown", heard };
  // Leaving voice mode is never blocked: it must always work.
  if (m.cmd !== "exit" && isCardEcho(heard, ctx.cardTexts, ctx.spoken))
    return { kind: "echo", cmd: m.cmd, heard };
  if (NEEDS_CARD.has(m.cmd) && !ctx.hasCard) return { kind: "no-card", cmd: m.cmd, heard };
  COMMAND_ACTIONS[m.cmd](ctx.actions as VoiceActions);
  return { kind: "done", cmd: m.cmd, heard };
}

/**
 * A strict command on this screen (it ran, or the badge says why not: a
 * card's own word, no card yet). The badge confirms it and the chat never
 * gets it; everything else is the chat's alone.
 */
export const isShown = (o: VoiceOutcome) =>
  o.kind === "done" || o.kind === "echo" || o.kind === "no-card";

/**
 * The mic tap (packages/debug-chat mic-taps.ts) for a screen: true (keep it
 * from the chat) only for a strict command, which runs and is confirmed on
 * the badge without waking the agent. Every other line goes to the chat as
 * it does with the mode off. The owner, 2026-11-03 03:12–03:14 JST:
 * "语音口令模式不应该影响我跟你发送指令", "当口令严格匹配的时候，也可以跳过触发你的".
 */
export function voiceTap(
  handle: (text: string) => VoiceOutcome,
  show: (o: VoiceOutcome) => void,
): (text: string) => boolean {
  return (text) => {
    const o = handle(text);
    if (!isShown(o)) return false;
    show(o);
    return true;
  };
}
