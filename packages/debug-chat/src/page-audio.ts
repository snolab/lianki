/**
 * Audio the page plays outside the chat's read-aloud (voice.ts): /words' word
 * clips and browser voices (WordsClient useSpeech). With echo cancellation
 * off (aec.ts) the mic holds its capture while any of it plays, and
 * RESUME_TAIL_MS after the last one ends (the room's echo), so a word read
 * aloud is never transcribed. MicButton's session combines this with the
 * chat's own hold. /read's read-aloud holds it whatever the setting
 * (`always`), and its text feeds the echo guard (`said`).
 *
 * One registry for the page, on globalThis, so the /words bundle and a
 * hot-loaded widget share it. Tiny on purpose: /words imports it statically.
 */

/** Capture resumes this long after the last sound ends (voice.ts RESUME_TAIL_MS). */
export const PAGE_AUDIO_TAIL_MS = 400;
/** A sound whose end never came (a lost event) stops holding the mic after this. */
export const PAGE_AUDIO_MAX_MS = 30_000;
const KEY = "__lkPageAudio";

/** What a sound says, for the mic's echo guard (echo.ts), and when. */
export type PageSaid = { text: string; start: number; end?: number };

export type StartOpts = {
  /** The words this sound says: a transcript that matches them is the page's echo. */
  text?: string;
  /**
   * Hold the mic even with echo cancellation on (/read's read-aloud): a whole
   * book read aloud leaks past the canceller often enough to post garbage.
   */
  always?: boolean;
};

export type PageAudio = {
  /** A sound starts; call the returned function once when it ends (again is a no-op). */
  start(o?: StartOpts): () => void;
  /** Something plays now, or ended less than the tail ago. */
  playing(): boolean;
  /** A sound started with `always` plays now, or ended less than the tail ago. */
  always(): boolean;
  /** Texts of sounds playing, or ended at most `windowMs` before `from`. */
  said(from: number, windowMs: number): PageSaid[];
  subscribe(f: (playing: boolean) => void): () => void;
  /**
   * The page listens to what the user says (/read's shadowing): `f` gets each
   * final transcript (and when its speech began) and returns true when it
   * consumed it, so the chat does not post it. null removes it.
   */
  listen(f: ((text: string, spokeAt: number) => boolean) | null): void;
  /** MicButton: offer a final transcript to the page's listener first. */
  heard(text: string, spokeAt: number): boolean;
  /** Whether the chat mic is on (MicButton sets it; subscribers are told). */
  mic(): boolean;
  setMic(on: boolean): void;
};

export function createPageAudio(
  d: {
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    now?: () => number;
    tailMs?: number;
    maxMs?: number;
  } = {},
): PageAudio {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = d.now ?? (() => Date.now());
  const tailMs = d.tailMs ?? PAGE_AUDIO_TAIL_MS;
  const maxMs = d.maxMs ?? PAGE_AUDIO_MAX_MS;
  const subs = new Set<(p: boolean) => void>();
  const emit = () => {
    for (const f of subs) f(all.on);
  };
  /** A count of live sounds that reads as "on" until the tail after the last one. */
  const channel = () => {
    const c = {
      live: 0,
      on: false,
      tail: null as unknown,
      begin() {
        c.live++;
        if (c.tail !== null) clearTimer(c.tail);
        c.tail = null;
        if (!c.on) {
          c.on = true;
          emit();
        }
      },
      finish() {
        c.live--;
        if (c.live > 0) return;
        c.tail = setTimer(() => {
          c.tail = null;
          if (c.live === 0 && c.on) {
            c.on = false;
            emit();
          }
        }, tailMs);
      },
    };
    return c;
  };
  const all = channel();
  const forced = channel();
  const said: PageSaid[] = [];
  let listener: ((text: string, spokeAt: number) => boolean) | null = null;
  let micOn = false;
  return {
    start(o = {}) {
      const rec: PageSaid | null = o.text?.trim() ? { text: o.text, start: now() } : null;
      if (rec) {
        said.push(rec);
        if (said.length > 50) said.shift();
      }
      all.begin();
      if (o.always) forced.begin();
      let done = false;
      let cap: unknown = null;
      const end = () => {
        if (done) return;
        done = true;
        clearTimer(cap);
        if (rec) rec.end = now();
        if (o.always) forced.finish();
        all.finish();
      };
      cap = setTimer(end, maxMs);
      return end;
    },
    playing: () => all.on,
    always: () => forced.on,
    said: (from, windowMs) => said.filter((r) => (r.end ?? now()) >= from - windowMs),
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    listen(f) {
      listener = f;
    },
    heard: (text, spokeAt) => !!listener?.(text, spokeAt),
    mic: () => micOn,
    setMic(on) {
      if (micOn === on) return;
      micOn = on;
      emit();
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
 * already AEC-off only), the page plays with echo cancellation off, or the
 * page plays a sound that always holds (/read's read-aloud).
 */
export const captureHeld = (
  chatHold: boolean,
  pagePlaying: boolean,
  aec: boolean,
  pageAlways = false,
) => chatHold || (pagePlaying && (!aec || pageAlways));
