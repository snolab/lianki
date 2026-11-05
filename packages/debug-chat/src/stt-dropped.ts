/**
 * The owner's own view of what the silence guard dropped (stt-guard.ts), so a
 * real line it took for a hallucination can be got back. On this device only:
 * in memory, gone on reload, never sent, never logged. Off until an owner
 * page turns it on, so no one else's mic ever keeps a dropped line.
 * On globalThis, so a hot-swapped widget still finds the mic's lines.
 */
import type { SttDropReason } from "./stt-guard";

export type DroppedLine = { at: number; text: string; reason: SttDropReason };

/** Enough to find the line he just lost. */
export const DROPPED_KEEP = 20;

type Store = { on: boolean; lines: DroppedLine[] };
const KEY = "__lkSttDropped";
const store = (): Store => {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  return (g[KEY] ??= { on: false, lines: [] });
};

/** The owner's page says so; anything else forgets what was kept. */
export function keepDroppedLines(on: boolean) {
  const s = store();
  s.on = on;
  if (!on) s.lines = [];
}

export function noteDropped(text: string, reason: SttDropReason, now: () => number = Date.now) {
  const s = store();
  if (!s.on) return;
  s.lines = [{ at: now(), text, reason }, ...s.lines].slice(0, DROPPED_KEEP);
}

/** Newest first. */
export const droppedLines = (): readonly DroppedLine[] => store().lines;

/** Took one back, or read them: it leaves the list. */
export function forgetDropped(line: DroppedLine) {
  const s = store();
  s.lines = s.lines.filter((l) => l !== line);
}
