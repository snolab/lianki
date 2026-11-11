/**
 * The mic going off without the user turning it off (owner 2026-11-11 19:08
 * JST, an Android PWA: "是你给我关的吗？"). Every off has a reason; the ones he
 * did not ask for show as their own state, "off by itself, tap to resume",
 * never as the plain off he chose. docs/voice-mode.md, "Mic off by itself".
 *
 * Pure decisions here (unit/mic-off.test.ts); mic-session.ts keeps the state
 * and MicButton.tsx draws it.
 */

/** Why the mic went off (or lost its track) by itself. */
export type AutoOffReason =
  /** The browser or the system ended the microphone track (a call, another app, the permission expiring). */
  | "track-ended"
  /** Another Lianki page on this device turned its mic on (debug-chat-tabs.ts: one listener per device). */
  | "other-tab"
  /** Speech recognition answered 401: signed out. */
  | "sign-in"
  /** /vibe took the room (mic-taps.ts block). */
  | "vibe"
  /** The echo-cancellation switch reopened the mic, and it did not come back. */
  | "reopen-failed"
  /** A newer widget took the session over, and its mic did not come back. */
  | "migrate-failed";

export type AutoOff = { reason: AutoOffReason; at: number };

/**
 * The button's look, one per state:
 * - "on": listening (or loading, capturing);
 * - "off": he turned it off (plain);
 * - "off-self": it went off by itself, or a reload could not resume it: one tap resumes.
 */
export type MicLook = "on" | "off" | "off-self";

export function micLook(v: { state: string; resume: boolean; auto?: AutoOff }): MicLook {
  if (v.state !== "off") return "on";
  return v.resume || v.auto ? "off-self" : "off";
}

/** Reasons the session tries to undo by itself once the page is visible: only a lost track. */
export const selfHealing = (r: AutoOffReason) => r === "track-ended";

/**
 * What a lost track does now: reopen at once (the page is visible), or wait
 * for the page to be visible again (a hidden page never asks for the mic: on
 * Android it is refused or hangs). Nothing when the mic is off.
 */
export function onTrackLost(at: { on: boolean; visible: boolean }): "reopen" | "wait" | "none" {
  if (!at.on) return "none";
  return at.visible ? "reopen" : "wait";
}

export type OffNoteStrings = {
  micCutOff: string;
  micOtherTab: string;
  micSignIn: string;
  micFailed: string;
};

/** The short note by the button for an off it did by itself (the user-facing reason). */
export function autoOffNote(reason: AutoOffReason, t: OffNoteStrings, blocked: string): string {
  switch (reason) {
    case "track-ended":
      return t.micCutOff;
    case "other-tab":
      return t.micOtherTab;
    case "sign-in":
      return t.micSignIn;
    case "vibe":
      return blocked;
    default:
      return t.micFailed;
  }
}

/** A track's state for the dev log: its readyState, and muted when the source gives nothing. */
export function trackNote(t: { readyState: string; muted?: boolean } | undefined): string {
  if (!t) return "none";
  return t.muted ? `${t.readyState}+muted` : t.readyState;
}
