/**
 * How loud the mic hears the speaker, frame by frame (32 ms), for the caret
 * that follows the voice in the chat bar (docs/local-stt.md, "Rolling
 * partials"). The owner's floor is the next feedback within 0.2 s of speech;
 * the transcript cannot always change that fast (the model may hold a syllable
 * back for a few passes), so the caret moves with every frame he speaks.
 *
 * A tiny bus, outside React: mic.ts publishes each frame's level, the caret
 * subscribes and writes its own style (no render per frame). Nothing is kept.
 */

/** 0 (silence) … 1 (clearly speaking). */
export type Level = number;

type Listener = (level: Level) => void;

const listeners = new Set<Listener>();

/** RMS that reads as full level when there is no VAD probability (a normal voice is ~0.05–0.1). */
const FULL_RMS = 0.1;

/** A frame's level: Silero's speech probability when there is one, else its loudness. */
export function levelOf(frame: Float32Array, prob?: number): Level {
  if (prob !== undefined && Number.isFinite(prob)) return Math.max(0, Math.min(1, prob));
  let e = 0;
  for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
  const rms = Math.sqrt(e / Math.max(1, frame.length));
  return Math.min(1, rms / FULL_RMS);
}

export function publishLevel(level: Level): void {
  for (const l of listeners) l(level);
}

export function subscribeLevel(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
