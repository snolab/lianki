// The /words first-visit walkthrough (app/(app)/words/WordsOnboarding.tsx):
// five short animated scenes, shown once, then folded into the circled "?"
// next to the page title, which replays it. Behind `words.onboarding`.
//
// "Seen" is an account preference (`words.onboarded`, docs/prefs-sync.md): a
// person who closed it on the phone is not shown it again on the laptop.
// Pure, apart from the storage helpers at the end.
import { notePrefWrite, SYNC_KEY } from "@lianki/ui-state/account";

/** On the account (lib/prefs/bindings.ts): "1" once it was finished or skipped. */
export const ONBOARDED_KEY = "lk:words-onboarded";

/**
 * Defaults, one named place (ready for the config store). Times are the
 * animation's pacing, not anything shown to the user.
 */
export const ONBOARDING_CONFIG = {
  /** How long each scene plays before the next, with motion on. */
  sceneMs: 4200,
  /**
   * On a device that has never synced preferences, wait this long for the
   * account's answer before showing: it may already say "seen".
   */
  firstSyncGraceMs: 1500,
  /** The fold into the "?" button. */
  foldMs: 380,
} as const;

/** The scenes, in order; each has its caption key in words-onboarding.content.ts. */
export const SCENES = ["tap", "rate", "handled", "returns", "pinch"] as const;
export type Scene = (typeof SCENES)[number];

export interface ShowState {
  /** The `words.onboarding` flag, from the server. */
  flagOn: boolean;
  /** The stored answer: true seen, false not, undefined never written. */
  seen: boolean | undefined;
}

/** Open it by itself on this visit? Only with the flag on and never seen. */
export function autoShow({ flagOn, seen }: ShowState): boolean {
  return flagOn && seen !== true;
}

/** The scene after `i` (null past the last), and before it (clamped at 0). */
export function nextScene(i: number): number | null {
  return i + 1 < SCENES.length ? i + 1 : null;
}
export function prevScene(i: number): number {
  return Math.max(0, i - 1);
}

/** "1" / "0" → boolean; anything else is "never written". */
export function parseSeen(raw: string | null | undefined): boolean | undefined {
  return raw === "1" ? true : raw === "0" ? false : undefined;
}

/**
 * This device has pulled the account's preferences before, so its local copy
 * of `words.onboarded` can be trusted at once (the sync record's cursor).
 */
export function hasSynced(record: string | null | undefined): boolean {
  if (!record) return false;
  try {
    const r = JSON.parse(record) as { cursor?: unknown };
    return typeof r.cursor === "number" && r.cursor > 0;
  } catch {
    return false;
  }
}

export function readSeen(): boolean | undefined {
  try {
    return parseSeen(localStorage.getItem(ONBOARDED_KEY));
  } catch {
    return undefined;
  }
}

export function deviceSynced(): boolean {
  try {
    return hasSynced(localStorage.getItem(SYNC_KEY));
  } catch {
    return false;
  }
}

/** Finished or skipped: remember it, on the account. */
export function markSeen() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {}
  notePrefWrite();
}
