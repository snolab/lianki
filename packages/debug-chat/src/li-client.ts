/**
 * The page's side of Li's sound hub, phase 0 (li-audio.ts; docs/li-sound-hub.md):
 * with the flag `voice.li-hub` on, on the owner's pages, it starts the hub and
 * sends what it sees to the Worker logs as `devLog` events:
 *
 * - `{ev: "audio-owner", mic, pinned, captures, claim, playing, page}` on each change;
 * - `{ev: "audio-conflict", kind: "two-captures" | "overlap", ...view}` as a collision begins.
 *
 * Off, it does nothing at all: no hub, no wrapper, no listener — the same
 * calls, the same DOM, the same timing as before. The app loads this module
 * only when the flag is on (DebugEval), so off it is not even fetched.
 */
import { type LiEnv, type LiHub, type LiView, dropLiHub, liHub } from "./li-audio";
import { pageAudio } from "./page-audio";
import { MIC_TAPS_KEY, type MicTaps } from "./mic-taps";

/** mic-session.ts MIC_SESSION_KEY, kept here so this module does not load the mic. */
const MIC_SESSION_KEY = "__lkMic";

export type LiClientOpts = {
  /** The flag `voice.li-hub` (and the owner's page). False: nothing happens. */
  on: boolean;
  /** Where the events go (the app's devLog). */
  log: (ev: Record<string, unknown>) => void;
  /** The browser's pieces; absent, the page's own (browserLiEnv). */
  env?: LiEnv;
};

let users = 0;

/** Start observing; returns the stop. With `on` false it returns a no-op and touches nothing. */
export function startLiClient(o: LiClientOpts): () => void {
  if (!o.on) return () => {};
  const hub: LiHub = liHub(o.env ?? browserLiEnv());
  users++;
  const send = (ev: Record<string, unknown>) => {
    try {
      o.log(ev);
    } catch {}
  };
  const offView = hub.subscribe((v: LiView) => send({ ev: "audio-owner", ...v }));
  const offConflict = hub.onConflict((c) => send({ ev: "audio-conflict", kind: c.kind, ...c.view }));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    offView();
    offConflict();
    if (--users === 0) dropLiHub(hub);
  };
}

/** The real page's pieces, each read lazily and guarded. */
export function browserLiEnv(): LiEnv {
  const g = globalThis as unknown as Record<string, unknown> & {
    navigator?: { mediaDevices?: LiEnv["media"] };
    HTMLMediaElement?: { prototype: LiEnv["mediaProto"] };
    speechSynthesis?: LiEnv["speech"];
  };
  return {
    target:
      typeof (g as unknown as EventTarget).addEventListener === "function"
        ? (g as unknown as EventTarget)
        : null,
    // The same registry every page feature uses (made on first use, as theirs is).
    pageAudio: () => pageAudio(),
    // Read only if a page feature already made it: the hub never creates the registry.
    taps: () => (g[MIC_TAPS_KEY] as MicTaps | undefined) ?? null,
    micState: () => {
      const s = g[MIC_SESSION_KEY] as { view?: () => { state?: string } } | undefined;
      return s?.view?.()?.state ?? null;
    },
    media: g.navigator?.mediaDevices ?? null,
    mediaProto: g.HTMLMediaElement?.prototype ?? null,
    speech: g.speechSynthesis ?? null,
  };
}
