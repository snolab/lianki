// The real browser pieces for lib/read/speaker.ts (kept apart so the unit
// suites, which use fakes, never load them).
import type { PageAudio } from "@lianki/debug-chat/page-audio";
import { audioOwner, audioOwnerId } from "@lianki/debug-chat/audio-claim";
import { createReadSpeaker, type AudioLike, type ReadSpeakerDeps, type UtterLike } from "./speaker";

export function browserReadSpeaker(pageAudio: () => PageAudio, mode: () => "speech" | "cloud") {
  return createReadSpeaker({
    mode,
    synth: () =>
      typeof speechSynthesis === "undefined"
        ? null
        : (speechSynthesis as unknown as ReturnType<ReadSpeakerDeps["synth"]>),
    utterance: (t) => new SpeechSynthesisUtterance(t) as unknown as UtterLike,
    fetch: (u, init) => fetch(u, init),
    audio: () => new Audio() as unknown as AudioLike,
    toUrl: (b) => URL.createObjectURL(b),
    revoke: (u) => URL.revokeObjectURL(u),
    pageAudio,
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    owner: (o) => audioOwner({ ...o, id: audioOwnerId("read") }),
  });
}
