/**
 * Waiting on the owner (docs/state-tree.md, "Waiting on the owner"): a
 * state-tree node that waits on him (waiting-owner, `needs`, a decision or an
 * approval) and reaches its etaAt is not late work. The progress hub
 * (workers/push/src/progress.ts) reminds him once, with the reason, then again
 * at growing intervals, until the node stops waiting on him.
 *
 * The spacing is a config key (lib/config.ts; live value from /dev/config,
 * read by the hub over DebugSessions.config, the default when it cannot).
 */
import { CONFIG } from "./config";
import { blockedOn, waitsOnOwner, type ProgressEntry } from "./progress";

export const OWNER_WAIT_REMIND_KEY = "chat.ownerWaitRemindDays" as const;
/** "1,3,7": a day after the first reminder, then three days, then seven, then weekly. */
export const OWNER_WAIT_REMIND_DEFAULT: string = CONFIG[OWNER_WAIT_REMIND_KEY].default;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The spacing in days from its text ("1,3,7"); the default's for anything invalid. */
export function parseRemindDays(v: unknown): number[] {
  const parsed = CONFIG[OWNER_WAIT_REMIND_KEY].schema.safeParse(v);
  const text = parsed.success ? parsed.data : OWNER_WAIT_REMIND_DEFAULT;
  return text.split(",").map((d) => Number(d.trim()));
}

/**
 * How long after reminder number `sent` (1 = the first, at etaAt) the next
 * one goes: the sent-th spacing, the last one repeating.
 */
export function remindDelayMs(days: readonly number[], sent: number): number {
  const list = days.length ? days : parseRemindDays(OWNER_WAIT_REMIND_DEFAULT);
  return list[Math.min(Math.max(sent, 1), list.length) - 1] * DAY_MS;
}

/**
 * An open node that waits on the owner (lib/progress.ts waitsOnOwner, without
 * to-do refs) at #823's slow spacing. Not one blocked on someone (`--who`):
 * those are nudged with backoff instead (lib/eta-nudge.ts).
 */
export const ownerWaits = (e: ProgressEntry) => waitsOnOwner(e) && !blockedOn(e);

/**
 * A write that moves a node onto or off the owner while its estimate has
 * already passed (the same etaAt; `entry` is changed in place):
 * - off (back to the lane's own work): the passing happened while it waited,
 *   so no "ETA reached" and no "未说明原因" for that etaAt (marked sent);
 * - onto, after the lane's "ETA reached" line: the owner's first reminder,
 *   with the reason, goes at once (the alarm sends it).
 * Anything else (a new estimate, one still ahead) is left to the alarm.
 */
export function ownerWaitTransition(
  prev: ProgressEntry | undefined,
  entry: ProgressEntry,
  t: number,
): void {
  const etaAt = entry.etaAt;
  if (!prev || etaAt === undefined || etaAt !== prev.etaAt || etaAt > t) return;
  const was = ownerWaits(prev);
  const now = ownerWaits(entry);
  if (was && !now) {
    entry.etaSent = etaAt;
    entry.etaSilent = etaAt;
  } else if (!was && now && entry.etaSent === etaAt && entry.remindFor !== etaAt) {
    entry.remindFor = etaAt;
    entry.remindN = 0;
    entry.remindAt = t;
  }
}

/**
 * Its next reminder is set and still belongs to its estimate (a new etaAt
 * starts over: the first reminder comes at that time).
 */
export const remindDue = (e: ProgressEntry) =>
  ownerWaits(e) && e.etaAt !== undefined && e.remindFor === e.etaAt && e.remindAt !== undefined;
