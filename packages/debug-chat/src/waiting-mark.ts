/**
 * The "waiting for your Learning Partner" state on the user's lines that the
 * partner has not answered yet (owner, 2026-11-10): with several pending,
 * only the LAST one carries the label; the earlier ones show the same state
 * colour as a small mark, with no text, but keep the label as their
 * accessible name and tooltip (so the state is never colour only). Pure:
 * unit/waiting-mark.test.ts.
 */

/** The waiting state's ink: muted, AA on the page in both themes (oklch). */
export const WAITING_INK = "light-dark(oklch(0.48 0.03 260), oklch(0.76 0.03 260))";

/** How line `i` shows the waiting state: the label, a mark, or nothing. */
export type WaitingMark = "label" | "mark" | null;

/**
 * Line `i` waits when the partner is offline, it is the user's (not the
 * agent's), and it comes after the agent's last line (`lastAgent`, -1 for
 * none). The last such line (`lastPending`) gets the label, the rest a mark.
 */
export function waitingMark(d: {
  i: number;
  from: string;
  agentOnline: boolean;
  lastAgent: number;
  lastPending: number;
}): WaitingMark {
  if (d.agentOnline || d.from === "agent" || d.i <= d.lastAgent) return null;
  return d.i === d.lastPending ? "label" : "mark";
}

/** The index of the last of the user's lines after the agent's last one; -1 for none. */
export function lastPendingIndex(messages: readonly { from: string }[]): number {
  const last = messages.length - 1;
  return last >= 0 && messages[last]!.from !== "agent" ? last : -1;
}
