/**
 * The mic's echo cancellation switch (lk:voice-aec, device-local:
 * docs/prefs-sync.md) and the constraints it selects. Kept small and free of
 * the mic code so /words can show the switch (its Settings sheet) without
 * loading the mic: the chat's ⋯ menu and /words both call applyAec.
 *
 * - On (the default): echoCancellation, noiseSuppression and autoGainControl.
 *   The mic stays open while anything plays; the user can talk over it
 *   (barge-in, voice.ts). On Chrome for Android this puts playback on the
 *   voice-call stream ("call mode"): a thinner speaker.
 * - Off ("0"): no processing at all. Playback stays on the media stream (the
 *   better sound), and the mic holds its capture while anything plays (the
 *   chat's read-aloud, voice.ts `hold`; /words' word audio, page-audio.ts)
 *   and RESUME_TAIL_MS after, so what the page plays is not transcribed.
 *
 * A change reopens the mic at once when it is on (mic-session.ts reopen), so
 * the difference is heard right away; otherwise it applies when it next opens.
 */

export const VOICE_AEC_KEY = "lk:voice-aec";
/** Window event after a change (detail: { on }), for switches shown elsewhere on the page. */
export const AEC_EVENT = "lk:voice-aec-change";
/** globalThis key of the page's mic session (mic-session.ts MIC_SESSION_KEY; a test keeps them equal). */
export const MIC_SESSION_GLOBAL = "__lkMic";

/** The mic with echo cancellation on (lk:voice-aec, the default). */
export const AEC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
} as const;
/**
 * lk:voice-aec = "0": no processing at all (echo cancellation, noise
 * suppression and auto gain all off), with capture held while the page plays
 * (half-duplex) and the text echo guard. The A/B against Android's call mode.
 */
export const RAW_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
} as const;
/** The old name of RAW_CONSTRAINTS. */
export const LEGACY_CONSTRAINTS = RAW_CONSTRAINTS;

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/** Echo cancellation on (default on; "0" = off, half-duplex). */
export const aecOn = (): boolean => read(VOICE_AEC_KEY) !== "0";

/** Write the switch (never throws). The mic is not touched: see applyAec. */
export function setAec(on: boolean) {
  try {
    if (on) localStorage.removeItem(VOICE_AEC_KEY);
    else localStorage.setItem(VOICE_AEC_KEY, "0");
  } catch {}
}

/** getUserMedia's audio constraints for a mode. */
export const micConstraints = (aec = aecOn()): MediaTrackConstraints =>
  aec ? { ...AEC_CONSTRAINTS } : { ...RAW_CONSTRAINTS };

/**
 * The mode the open mic track was opened with (null: none opened yet on this
 * page), and who to tell when it changes. On globalThis: the /words bundle
 * and a hot-loaded widget each have their own copy of this module.
 */
type Opened = { aec: boolean | null; subs: Set<() => void> };
const openedState = (): Opened => {
  const g = globalThis as unknown as Record<string, Opened | undefined>;
  return (g.__lkAecOpened ??= { aec: null, subs: new Set() });
};
export function noteOpened(aec: boolean) {
  const o = openedState();
  const was = o.aec;
  o.aec = aec;
  if (was !== aec) for (const f of o.subs) f();
}
/** `f` runs when the mic opens in another mode than before (a reopen): the hold is worked out again. */
export function onOpened(f: () => void) {
  const subs = openedState().subs;
  subs.add(f);
  return () => void subs.delete(f);
}
export const openedAec = () => openedState().aec;
/**
 * The mode in force: the open track's, else the switch's. What the hold and
 * the clip metadata go by, so they always match the track.
 */
export const micAec = (): boolean => openedAec() ?? aecOn();

type Reopenable = { view(): { state: string }; reopen?(): Promise<boolean> };

/**
 * The switch, from a tap: write it, tell the page, and reopen the mic if it is
 * on. "reopened": the new mode is live now; "next-open": the mic is off (or
 * an older session cannot reopen), so it applies when it next opens.
 */
export async function applyAec(
  on: boolean,
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): Promise<"reopened" | "next-open"> {
  setAec(on);
  try {
    globalThis.dispatchEvent?.(new CustomEvent(AEC_EVENT, { detail: { on } }));
  } catch {}
  const m = g[MIC_SESSION_GLOBAL] as Reopenable | undefined;
  if (!m || m.view().state === "off" || !m.reopen) return "next-open";
  try {
    return (await m.reopen()) ? "reopened" : "next-open";
  } catch {
    return "next-open";
  }
}
