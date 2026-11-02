/**
 * The /words voice mode's ear (docs/voice-mode.md): the page's own mic
 * session (packages/debug-chat mic-session.ts, `__lkMic`), the one the chat
 * mic uses, with a command tap in front of the chat and the wake word pinned
 * off. Transcripts come from the owner's local streaming STT when its URL is
 * set (lower latency), else from the same cloud route as the chat mic.
 *
 * Loaded only when voice mode turns on (a dynamic import), so the mic code
 * stays out of the /words bundle. Browser glue: its logic is in
 * voice-commands.ts, voice-dispatch.ts and mic-taps.ts, which are unit-tested;
 * this file is exercised by scripts/qa/qa-voice-mode.mjs.
 */
import { micTaps } from "@lianki/debug-chat/mic-taps";
import { pageMic } from "@lianki/debug-chat/MicButton";
import { LOCAL_STT_KEY, localSttFrom } from "@lianki/debug-chat/local-stt";
import { getKey } from "@lianki/debug-chat/storage-keys";

/** The session shape that consults the command taps (mic-session.ts MIC_SESSION_V). */
const TAPS_SINCE_V = 10;

export type VoiceEar = {
  /** Stop: the tap and the pin go; the mic goes off only if voice mode turned it on. */
  stop(): Promise<void>;
};

export type VoiceEarState = "starting" | "listening" | "failed";

export async function startVoiceEar(opts: {
  /** A final transcript; true keeps it from the chat. */
  onText: (text: string) => boolean;
  onState: (s: VoiceEarState) => void;
}): Promise<VoiceEar> {
  const taps = micTaps();
  // The tap and the pin first: a session made or migrated from here on sees them.
  const untap = taps.tap(opts.onText);
  const unpin = taps.pin();
  let opened = false;
  let unsub = () => {};
  const stop = async () => {
    untap();
    unpin();
    unsub();
    if (opened) {
      const m = pageMic();
      if (m.view().state !== "off") await m.off();
    }
  };
  try {
    opts.onState("starting");
    const m = pageMic();
    // An older session (a hot-loaded widget built before taps) never asks the tap.
    if (m.v < TAPS_SINCE_V) throw new Error(`mic session v${m.v} has no command taps`);
    const local = localSttFrom(getKey(LOCAL_STT_KEY));
    const cfg = m.configured();
    if (local && !cfg.localStt) m.configure({ ...cfg, localStt: local });
    let ready = false;
    // The mic turned off under it (the chat's mic button, Escape): deaf until a tap.
    unsub = m.subscribe((v) => {
      if (v.state === "off") {
        if (ready) opts.onState("failed");
      } else opts.onState(v.state === "loading" ? "starting" : "listening");
    });
    if (m.view().state === "off") {
      opened = true;
      await m.toggle();
    }
    if (m.view().state === "off") throw new Error("microphone did not start");
    ready = true;
  } catch (e) {
    console.warn("[voice-mode]", (e as Error)?.message ?? e);
    opts.onState("failed");
    await stop();
    throw e;
  }
  return { stop };
}
