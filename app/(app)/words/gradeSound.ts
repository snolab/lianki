/**
 * Short, quiet tones that confirm a grade without looking — eyes-free study.
 *
 * Pitch climbs with the grade, so the four tell apart by ear: Again falls
 * (E4 → C4), Hard is one G4, Good one C5 (the most-pressed, so the shortest),
 * Easy rises (C5 → G5). Undo is a quick downward glide. Synthesized with Web
 * Audio — no files, works offline. A new tone cuts the previous one off, so
 * fast grading never piles up into a chord.
 */
export type GradeTone = 1 | 2 | 3 | 4 | "undo";

const NOTES: Record<1 | 2 | 3 | 4, number[]> = {
  1: [329.63, 261.63],
  2: [392.0],
  3: [523.25],
  4: [523.25, 783.99],
};
const NOTE_S = 0.06;
const VOLUME = 0.06;

let ctx: AudioContext | null = null;
let last: GainNode | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** One soft plucked note (sine, instant attack, exponential decay). */
function pluck(
  ac: AudioContext,
  out: AudioNode,
  freq: number,
  at: number,
  len: number,
  to?: number,
) {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, at + len);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(1, at + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + len + 0.01);
}

export function playGradeTone(tone: GradeTone) {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  // Cut the previous tone short.
  if (last) {
    last.gain.cancelScheduledValues(now);
    last.gain.setTargetAtTime(0, now, 0.005);
  }
  const master = ac.createGain();
  master.gain.value = VOLUME;
  master.connect(ac.destination);
  last = master;
  if (tone === "undo") pluck(ac, master, 880, now, 0.08, 440);
  else
    NOTES[tone].forEach((f, k) =>
      pluck(ac, master, f, now + k * NOTE_S, tone === 3 ? NOTE_S * 0.8 : NOTE_S),
    );
  setTimeout(() => master.disconnect(), 400);
}
