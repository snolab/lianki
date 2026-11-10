/**
 * Receipts, backoff, blocked and paused (docs/state-tree.md, "Receipts",
 * "Backoff", "Blocked and paused"; peer feedback adopted 2026-11-11). Shared
 * by the progress hub (workers/push/src/progress.ts) and the tests.
 *
 * - An "ETA reached" line carries a receipt code. The clock starts when a
 *   listener got it (no listener: queued, the clock waits). No ack within
 *   chat.etaAckMin → the coordinating lane (chat.etaCoordinator) is told;
 *   chat.etaOwnerMin later, still no reason and new ETA → the owner hears
 *   "<name> 超时，未说明原因", then again at chat.nudgeBackoffMin spacing.
 * - Blocked on someone (`--who`) nudges that one at the same spacing; paused
 *   (status waiting) gets nothing: no nudges, no overrun.
 *
 * Every number is a config key (lib/config.ts); the hub reads the live value
 * over DebugSessions.config and uses these defaults when it cannot.
 */
import { CONFIG } from "./config";
import { type ProgressEntry, blockedOn, isPaused, nudgeKey } from "./progress";
import { ownerWaits } from "./owner-wait";

export const ETA_ACK_KEY = "chat.etaAckMin" as const;
export const ETA_OWNER_KEY = "chat.etaOwnerMin" as const;
export const ETA_COORDINATOR_KEY = "chat.etaCoordinator" as const;
export const NUDGE_BACKOFF_KEY = "chat.nudgeBackoffMin" as const;
export const VERIFY_ETA_KEY = "chat.verifyEtaMin" as const;
export const ETA_NUDGE_KEYS = [
  ETA_ACK_KEY,
  ETA_OWNER_KEY,
  ETA_COORDINATOR_KEY,
  NUDGE_BACKOFF_KEY,
  VERIFY_ETA_KEY,
] as const;

const MIN = 60_000;

/** The hub's rules, as numbers: the live config values, or the defaults. */
export type NudgeRules = {
  ackMs: number;
  ownerMs: number;
  coordinator: string;
  backoffMs: number[];
  verifyMs: number;
};

/** The rules from config values (any missing or invalid one: its default). */
export function nudgeRules(values: Partial<Record<string, unknown>> = {}): NudgeRules {
  const pick = <K extends (typeof ETA_NUDGE_KEYS)[number]>(k: K) => {
    const p = CONFIG[k].schema.safeParse(values[k]);
    return (p.success ? p.data : CONFIG[k].default) as (typeof CONFIG)[K]["default"];
  };
  return {
    ackMs: pick(ETA_ACK_KEY) * MIN,
    ownerMs: pick(ETA_OWNER_KEY) * MIN,
    coordinator: pick(ETA_COORDINATOR_KEY),
    backoffMs: pick(NUDGE_BACKOFF_KEY)
      .split(",")
      .map((m) => Number(m.trim()) * MIN),
    verifyMs: pick(VERIFY_ETA_KEY) * MIN,
  };
}

/** The defaults, for callers with no config to read. */
export const NUDGE_DEFAULTS: NudgeRules = nudgeRules();

/** After nudge number `sent` (1 = the first), how long until the next: the list, its last repeating. */
export function backoffDelayMs(list: readonly number[], sent: number): number {
  const l = list.length ? list : NUDGE_DEFAULTS.backoffMs;
  return l[Math.min(Math.max(sent, 1), l.length) - 1]!;
}

/**
 * Its estimate passing is not late work: it waits on the owner (#823's
 * reminders), is blocked on someone (nudged instead) or paused.
 */
export const holdsEta = (e: ProgressEntry) => ownerWaits(e) || isPaused(e) || !!blockedOn(e);

/**
 * A write that leaves a hold (paused, blocked) while the same estimate has
 * already passed: the passing happened while it was held, so no "ETA
 * reached" and no "未说明原因" for it (marked sent and silent). And a node
 * that just became blocked on someone, or changed who or what: its nudges
 * start over, the first at once. `entry` is changed in place.
 */
export function holdTransition(
  prev: ProgressEntry | undefined,
  entry: ProgressEntry,
  t: number,
): void {
  const key = nudgeKey(entry);
  if (key === undefined) {
    delete entry.nudgeFor;
    delete entry.nudgeN;
    delete entry.nudgeAt;
    delete entry.nudgeQueued;
  } else if (entry.nudgeFor !== key) {
    entry.nudgeFor = key;
    entry.nudgeN = 0;
    entry.nudgeAt = t;
    delete entry.nudgeQueued;
  }
  const etaAt = entry.etaAt;
  if (!prev || etaAt === undefined || etaAt !== prev.etaAt || etaAt > t) return;
  const held = (e: ProgressEntry) => isPaused(e) || !!blockedOn(e);
  if (held(prev) && !holdsEta(entry)) {
    entry.etaSent = etaAt;
    entry.etaSilent = etaAt;
  }
}

/** Blocked on someone, and its next nudge is set. */
export const nudgeDue = (e: ProgressEntry) =>
  e.status !== "done" &&
  nudgeKey(e) !== undefined &&
  e.nudgeFor === nudgeKey(e) &&
  e.nudgeAt !== undefined;
