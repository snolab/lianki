import type { GrantWords } from "./wire";

/**
 * The connection chip's two readings (LinkChip.tsx; docs/dev-debug-widget.md,
 * "Connection chip"), left of the progress bar on a developer's chat:
 *
 * - **Remote code** (`EvalLink`): can a sender's code reach THIS page now?
 *   off · connecting · connected · disconnected. "disconnected" is also the
 *   state where the hub is reached and an eval grant is live, but it does not
 *   cover this page (the app restarted under a new page id; docs/monitoring.md,
 *   "After a reload") — the state that used to be invisible.
 * - **Selection** (`SelectionState`): has the agent got the page selection
 *   attached to the chat? none · pending · seen · failed.
 *
 * Delivery nouns (`DELIVERY`), one vocabulary for the chip and, later, the
 * chat's message marks: sent (left this page) → delivered (the hub has it and
 * an agent is listening) → seen (an agent acted on it: a beat or a reply after
 * it) → handled (answered); failed (it reached no agent). The chip's
 * "pending" is sent or delivered, not yet seen.
 *
 * Pure: unit-tested in unit/link-state.test.ts.
 */

export const EVAL_LINK_STATES = ["off", "connecting", "connected", "disconnected"] as const;
export type EvalLink = (typeof EVAL_LINK_STATES)[number];

export const SELECTION_STATES = ["none", "pending", "seen", "failed"] as const;
export type SelectionState = (typeof SELECTION_STATES)[number];

/** The delivery vocabulary shared with message marks (not all used by the chip yet). */
export const DELIVERY = ["sent", "delivered", "seen", "handled", "failed"] as const;
export type Delivery = (typeof DELIVERY)[number];

/** The page's hub socket: being opened, open, or closed (dropped, refused, idle). */
export type SocketPhase = "opening" | "open" | "closed";

/** An eval session as the hub lists it to this page (HubState.sessions). */
export type EvalSession = {
  pair: string;
  label: string;
  scope?: string;
  until?: number;
  /** The page ids it reaches; absent = every page. */
  pages?: string[];
};

/** The eval sessions in time, and whether each reaches this page (`self`). */
export function evalSessions(
  sessions: readonly EvalSession[] | undefined,
  self: string | undefined,
  now: number,
): (EvalSession & { here: boolean })[] {
  return (sessions ?? [])
    .filter((s) => s.scope !== "chat" && (s.until ?? 0) > now)
    .map((s) => ({ ...s, here: !s.pages || (!!self && s.pages.includes(self)) }));
}

/**
 * Remote code on this page: `off` with debug mode off, or no eval grant held
 * for this page's account; `connecting` while the socket opens; `connected`
 * when a grant in time reaches this page; `disconnected` when the socket is
 * closed, or a grant is live but leaves this page out.
 */
export function evalLink(o: {
  debug: boolean;
  socket: SocketPhase;
  sessions: readonly EvalSession[] | undefined;
  self?: string;
  now: number;
}): EvalLink {
  if (!o.debug) return "off";
  if (o.socket === "opening") return "connecting";
  if (o.socket === "closed") return "disconnected";
  const live = evalSessions(o.sessions, o.self, o.now);
  if (!live.length) return "off";
  return live.some((s) => s.here) ? "connected" : "disconnected";
}

/** A chat line as the chip reads it. */
export type LinkLine = { from: string; at: number; context?: unknown };

/**
 * The page selection: `pending` while one is attached and not yet sent, or
 * sent and not yet seen; `seen` once an agent replied after the line that
 * carried it, or beat ("working") after it; `failed` when its send failed, or
 * no agent listens and none saw it; `none` with nothing attached or sent.
 * Only the newest line carrying a selection counts.
 */
export function selectionState(o: {
  attached: boolean;
  lines: readonly LinkLine[];
  beatAt?: number;
  listeners: number;
  sendFailed?: boolean;
}): SelectionState {
  if (o.sendFailed) return "failed";
  if (o.attached) return "pending";
  let sent: LinkLine | undefined;
  for (let i = o.lines.length - 1; i >= 0; i--) {
    const l = o.lines[i]!;
    if (l.from === "owner" && l.context) {
      sent = l;
      break;
    }
  }
  if (!sent) return "none";
  const at = sent.at;
  if ((o.beatAt ?? 0) > at || o.lines.some((l) => l.from === "agent" && l.at > at)) return "seen";
  return o.listeners > 0 ? "pending" : "failed";
}

/**
 * Time left on a grant, for people: hours under two days ("5 hours", "1 hour"),
 * else whole days rounded ("30 days"), from the grant length's words.
 */
export function timeLeft(ms: number, w: GrantWords): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours === 1) return w.grantHour;
  if (hours < 48) return w.grantHours.replaceAll("{n}", String(hours));
  return w.grantDays.replaceAll("{n}", String(Math.round(hours / 24)));
}
