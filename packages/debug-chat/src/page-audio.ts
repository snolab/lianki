/**
 * Audio the page plays outside the chat's read-aloud (voice.ts): /words' word
 * clips and browser voices (WordsClient useSpeech). With echo cancellation
 * off (aec.ts) the mic holds its capture while any of it plays, and
 * RESUME_TAIL_MS after the last one ends (the room's echo), so a word read
 * aloud is never transcribed. MicButton's session combines this with the
 * chat's own hold.
 *
 * One registry for the page, on globalThis, so the /words bundle and a
 * hot-loaded widget share it. Tiny on purpose: /words imports it statically.
 */

/** Capture resumes this long after the last sound ends (voice.ts RESUME_TAIL_MS). */
export const PAGE_AUDIO_TAIL_MS = 400;
/** A sound whose end never came (a lost event) stops holding the mic after this. */
export const PAGE_AUDIO_MAX_MS = 30_000;
const KEY = "__lkPageAudio";

export type PageAudio = {
  /** A sound starts; call the returned function once when it ends (again is a no-op). */
  start(): () => void;
  /** Something plays now, or ended less than the tail ago. */
  playing(): boolean;
  subscribe(f: (playing: boolean) => void): () => void;
};

export function createPageAudio(
  d: {
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    tailMs?: number;
    maxMs?: number;
  } = {},
): PageAudio {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const tailMs = d.tailMs ?? PAGE_AUDIO_TAIL_MS;
  const maxMs = d.maxMs ?? PAGE_AUDIO_MAX_MS;
  let live = 0;
  let on = false;
  let tail: unknown = null;
  const subs = new Set<(p: boolean) => void>();
  const set = (p: boolean) => {
    if (on === p) return;
    on = p;
    for (const f of subs) f(p);
  };
  return {
    start() {
      live++;
      if (tail !== null) clearTimer(tail);
      tail = null;
      set(true);
      let done = false;
      let cap: unknown = null;
      const end = () => {
        if (done) return;
        done = true;
        clearTimer(cap);
        live--;
        if (live > 0) return;
        tail = setTimer(() => {
          tail = null;
          if (live === 0) set(false);
        }, tailMs);
      };
      cap = setTimer(end, maxMs);
      return end;
    },
    playing: () => on,
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

/** The page's registry, shared by every copy of this module. */
export function pageAudio(): PageAudio {
  const g = globalThis as unknown as Record<string, PageAudio | undefined>;
  return (g[KEY] ??= createPageAudio());
}

/**
 * Whether the mic holds its capture: the chat is reading (its own hold,
 * already AEC-off only), or the page plays with echo cancellation off.
 */
export const captureHeld = (chatHold: boolean, pagePlaying: boolean, aec: boolean) =>
  chatHold || (pagePlaying && !aec);
