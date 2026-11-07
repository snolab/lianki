// The real browser pieces for lib/read/speaker.ts (kept apart so the unit
// suites, which use fakes, never load them).
import type { PageAudio } from "@lianki/debug-chat/page-audio";
import { audioOwner, audioOwnerId } from "@lianki/debug-chat/audio-claim";
import { outputBed } from "@lianki/debug-chat/output-bed";
import { existingCtx } from "@lianki/debug-chat/voice-out";
import {
  createReadSpeaker,
  readRoute,
  type AudioLike,
  type ReadSpeakerDeps,
  type UtterLike,
} from "./speaker";

type RouteCtx = {
  state: string;
  destination: AudioNode;
  createMediaElementSource(el: HTMLMediaElement): AudioNode;
};

export function browserReadSpeaker(pageAudio: () => PageAudio, mode: () => "speech" | "cloud") {
  // Listening for taps from now on (the Play tap comes after this).
  outputBed();
  return createReadSpeaker({
    mode,
    synth: () =>
      typeof speechSynthesis === "undefined"
        ? null
        : (speechSynthesis as unknown as ReturnType<ReadSpeakerDeps["synth"]>),
    utterance: (t) => new SpeechSynthesisUtterance(t) as unknown as UtterLike,
    fetch: (u, init) => fetch(u, init),
    route: () => readRoute(pageAudio(), existingCtx()),
    audio: (route) => {
      const a = new Audio();
      const ctx = route as RouteCtx | null;
      if (ctx) {
        try {
          ctx.createMediaElementSource(a).connect(ctx.destination);
        } catch {
          // Not routed: it plays as a bare element (ducked while the mic captures on iOS).
        }
      }
      return a as unknown as AudioLike;
    },
    toUrl: (b) => URL.createObjectURL(b),
    revoke: (u) => URL.revokeObjectURL(u),
    pageAudio,
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    owner: (o) => audioOwner({ ...o, id: audioOwnerId("read") }),
    preroll: () => outputBed().begin(),
  });
}
