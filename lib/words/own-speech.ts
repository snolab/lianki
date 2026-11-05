/**
 * /words' browser voice, cancelled only when it is ours (owner, 2026-11-05):
 * `speechSynthesis.cancel()` silences the whole page, so a card change while
 * Li speaks (packages/debug-chat/src/voice.ts) cut Li off. This keeps the
 * utterances /words handed to the engine and cancels only while one of them
 * is still queued or playing.
 */

type Utter = {
  addEventListener(type: "end" | "error", f: () => void): void;
};
export type SynthLike<U extends Utter> = { speak(u: U): void; cancel(): void };

export function ownSpeech<U extends Utter>(synth: () => SynthLike<U> | null) {
  const mine = new Set<U>();
  return {
    speak(u: U) {
      const s = synth();
      if (!s) return;
      mine.add(u);
      const done = () => void mine.delete(u);
      u.addEventListener("end", done);
      u.addEventListener("error", done);
      s.speak(u);
    },
    /** Silence ours; someone else's voice (Li) plays on. */
    cancel() {
      if (!mine.size) return;
      mine.clear();
      try {
        synth()?.cancel();
      } catch {}
    },
    /** One of ours is queued or playing. */
    busy: () => mine.size > 0,
  };
}
