/**
 * The word being spoken in an example read aloud, karaoke-style (owner,
 * 2026-11-05 01:10 JST: options 1 and 2; forced alignment dropped).
 *
 * 1. Estimate (the cloud voice, recorded clips: audio with no word times):
 *    the sentence is cut into words by Intl.Segmenter — one engine for every
 *    language, word granularity also for scripts without spaces — and each
 *    word gets a share of the audio's real duration in proportion to its
 *    length, with extra weight at punctuation for the pause there
 *    (`timeline`, `wordAt`). The playback loop reads audio.currentTime each
 *    frame (`followAudio`).
 * 2. Browser voice: SpeechSynthesisUtterance `boundary` events say exactly
 *    where the voice is (`wordAtChar`); an engine that sends none falls back
 *    to the estimate over an estimated duration (`followSpeech`).
 *
 * The spoken stretch is published in a tiny store (`spokenWord`), which the
 * example renderer (MarkedExample) reads for the one example it shows.
 */

/** A stretch of the text, [start, end) in UTF-16 units. */
export type Span = readonly [number, number];

/** A word of the sentence and its share of the audio, as fractions of the whole [0, 1]. */
export type Slot = { start: number; end: number; t0: number; t1: number };

const segCache = new Map<string, Intl.Segmenter>();
function wordSegmenter(lang: string): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || !("Segmenter" in Intl)) return null;
  let s = segCache.get(lang);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang || undefined, { granularity: "word" });
    } catch {
      s = new Intl.Segmenter(undefined, { granularity: "word" });
    }
    segCache.set(lang, s);
  }
  return s;
}

/**
 * Graphemes of syllabic scripts (Han, kana, Hangul) each take about a
 * syllable to say; an alphabet's letter, about a sound. Script data, the same
 * rule for every language.
 */
const SYLLABIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SYLLABLE_WEIGHT = 3;

/** How long a word takes to say, in letter units. */
export function wordWeight(word: string): number {
  let w = 0;
  for (const ch of word.normalize("NFC")) {
    if (/\p{M}/u.test(ch)) continue;
    w += SYLLABIC.test(ch) ? SYLLABLE_WEIGHT : 1;
  }
  return Math.max(1, w);
}

/** The pause a voice makes at a sentence's end, and at a comma, in average words. */
const STOP_PAUSE = 1;
const COMMA_PAUSE = 0.5;

/** The pause after a stretch of punctuation, in average words (0: none). */
export function pauseAfter(punct: string): number {
  if (/\p{Sentence_Terminal}/u.test(punct)) return STOP_PAUSE;
  if (/\p{Terminal_Punctuation}|[–—]/u.test(punct)) return COMMA_PAUSE;
  return 0;
}

const lineCache = new Map<string, Slot[]>();
const LINE_CAP = 200;

/**
 * Each word of `text` and its share of the audio. A pause belongs to no word:
 * the word before it stays lit through it (`wordAt`).
 */
export function timeline(text: string, lang: string): Slot[] {
  const k = `${lang}\n${text}`;
  const hit = lineCache.get(k);
  if (hit) return hit;
  const seg = wordSegmenter(lang);
  type Raw = { start: number; end: number; w: number; pause: number };
  const words: Raw[] = [];
  if (seg) {
    for (const s of seg.segment(text)) {
      if (s.isWordLike) {
        words.push({
          start: s.index,
          end: s.index + s.segment.length,
          w: wordWeight(s.segment),
          pause: 0,
        });
      } else if (words.length) {
        const last = words[words.length - 1];
        last.pause = Math.max(last.pause, pauseAfter(s.segment));
      }
    }
  } else {
    for (const m of text.matchAll(/\S+/g))
      words.push({ start: m.index!, end: m.index! + m[0].length, w: wordWeight(m[0]), pause: 0 });
  }
  // The last word's pause is the clip's end: nothing comes after it.
  if (words.length) words[words.length - 1].pause = 0;
  const avg = words.reduce((a, r) => a + r.w, 0) / Math.max(1, words.length);
  const total = words.reduce((a, r) => a + r.w + r.pause * avg, 0);
  const out: Slot[] = [];
  let at = 0;
  for (const r of words) {
    const t0 = at / total;
    at += r.w;
    out.push({ start: r.start, end: r.end, t0, t1: at / total });
    at += r.pause * avg;
  }
  if (lineCache.size >= LINE_CAP) lineCache.delete(lineCache.keys().next().value!);
  lineCache.set(k, out);
  return out;
}

/** The slot spoken at `fraction` of the audio (0..1): the last one begun. -1 before any. */
export function wordAt(slots: readonly Slot[], fraction: number): number {
  if (!slots.length || !(fraction >= 0)) return -1;
  let lo = 0;
  let hi = slots.length - 1;
  if (fraction < slots[0].t0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slots[mid].t0 <= fraction) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The word a boundary event points at: the one holding `charIndex`, or the
 * next one after it (an engine may point at the space before a word). -1 past
 * the last word.
 */
export function wordAtChar(slots: readonly Slot[], charIndex: number): number {
  for (let i = 0; i < slots.length; i++) if (charIndex < slots[i].end) return i;
  return -1;
}

/** Letter units of the sentence, the estimate's measure of how long it takes. */
export function sentenceUnits(text: string, lang: string): number {
  const seg = wordSegmenter(lang);
  let u = 0;
  let words = 0;
  let pauses = 0;
  if (seg) {
    for (const s of seg.segment(text)) {
      if (s.isWordLike) {
        u += wordWeight(s.segment);
        words++;
      } else pauses += pauseAfter(s.segment);
    }
  } else
    for (const m of text.matchAll(/\S+/g)) {
      u += wordWeight(m[0]);
      words++;
    }
  return u + (pauses * u) / Math.max(1, words);
}

/**
 * Seconds per letter unit, learnt per language from what was actually played
 * (each clip's real duration, each utterance's real length); the first guess
 * is an ordinary speaking pace and is replaced by the first real one.
 */
const FIRST_GUESS_S_PER_UNIT = 0.075;
const pace = new Map<string, number>();
export function learnPace(lang: string, units: number, seconds: number) {
  if (!(units > 0) || !(seconds > 0) || !Number.isFinite(seconds)) return;
  const v = seconds / units;
  const old = pace.get(lang);
  pace.set(lang, old === undefined ? v : old * 0.7 + v * 0.3);
}
/** How long `text` will take to say, in seconds, at speech rate `rate`. */
export function estimateSeconds(text: string, lang: string, rate = 1): number {
  return (sentenceUnits(text, lang) * (pace.get(lang) ?? FIRST_GUESS_S_PER_UNIT)) / (rate || 1);
}
/** For tests: forget learnt paces. */
export function resetPace() {
  pace.clear();
}

// ── The store ──────────────────────────────────────────────────────────────

export type Spoken = { text: string; lang: string; span: Span } | null;
let current: Spoken = null;
const listeners = new Set<() => void>();
export const spokenWord = {
  get: (): Spoken => current,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  set(next: Spoken) {
    const same =
      next === current ||
      (next &&
        current &&
        next.text === current.text &&
        next.lang === current.lang &&
        next.span[0] === current.span[0] &&
        next.span[1] === current.span[1]);
    if (same) return;
    current = next;
    for (const fn of listeners) fn();
  },
};

/** The spoken stretch inside `text`, as shown (its own offsets), or null. */
export function spokenIn(s: Spoken, text: string): Span | null {
  if (!s) return null;
  const at = text.indexOf(s.text);
  if (at < 0 || text.trim() !== s.text.trim()) return null;
  return [s.span[0] + at, s.span[1] + at];
}

// ── Followers ──────────────────────────────────────────────────────────────

export type Frames = {
  request(fn: () => void): unknown;
  cancel(h: unknown): void;
};
export type AudioClock = {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended?: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

type Out = (s: Spoken) => void;

/**
 * Follow a playing clip: each frame while it plays, the word at
 * currentTime / duration. The loop runs only while the clip plays; a pause or
 * the end clears the mark. Returns a stop that clears it too.
 */
export function followAudio(
  el: AudioClock,
  text: string,
  lang: string,
  frames: Frames,
  out: Out = spokenWord.set,
): () => void {
  const slots = timeline(text, lang);
  let h: unknown = null;
  let learnt = false;
  const show = () => {
    // A clip whose length is not known (yet, or ever: some streams) is
    // estimated, and held on the last word if it runs longer.
    const known = el.duration > 0 && Number.isFinite(el.duration);
    const d = known ? el.duration : estimateSeconds(text, lang);
    if (known && !learnt) {
      learnt = true;
      learnPace(lang, sentenceUnits(text, lang), d);
    }
    const i = wordAt(slots, Math.min(1, el.currentTime / d));
    out(i < 0 ? null : { text, lang, span: [slots[i].start, slots[i].end] });
  };
  const tick = () => {
    h = null;
    if (el.paused || el.ended) return;
    show();
    h = frames.request(tick);
  };
  const run = () => {
    if (h === null) h = frames.request(tick);
  };
  const halt = () => {
    if (h !== null) frames.cancel(h);
    h = null;
    out(null);
  };
  el.addEventListener("playing", run);
  el.addEventListener("pause", halt);
  el.addEventListener("ended", halt);
  if (!el.paused) run();
  return () => {
    el.removeEventListener("playing", run);
    el.removeEventListener("pause", halt);
    el.removeEventListener("ended", halt);
    halt();
  };
}

/** How long after the voice starts a first boundary event may take before the estimate takes over. */
export const BOUNDARY_WAIT_MS = 500;

/**
 * Follow a browser utterance. Its `boundary` events give the exact word; with
 * none within BOUNDARY_WAIT_MS of the start, the word is estimated from the
 * time since the start over an estimated duration (and held on the last word
 * if the voice runs longer). The caller wires the utterance's events here.
 */
export function followSpeech(
  text: string,
  lang: string,
  rate: number,
  d: {
    now(): number;
    frames: Frames;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
  },
  out: Out = spokenWord.set,
) {
  const slots = timeline(text, lang);
  let started = -1;
  let exact = false;
  let timer: unknown = null;
  let h: unknown = null;
  let done = false;
  const total = estimateSeconds(text, lang, rate) * 1000;
  const mark = (i: number) =>
    out(i < 0 ? null : { text, lang, span: [slots[i].start, slots[i].end] });
  const tick = () => {
    h = null;
    if (done || exact) return;
    mark(wordAt(slots, Math.min(0.999, (d.now() - started) / total)));
    h = d.frames.request(tick);
  };
  const stopLoop = () => {
    if (timer !== null) d.clearTimer(timer);
    timer = null;
    if (h !== null) d.frames.cancel(h);
    h = null;
  };
  return {
    start() {
      if (done || started >= 0) return;
      started = d.now();
      timer = d.setTimer(() => {
        timer = null;
        if (!done && !exact) h = d.frames.request(tick);
      }, BOUNDARY_WAIT_MS);
    },
    boundary(charIndex: number, name?: string) {
      if (done || (name && name !== "word")) return;
      exact = true;
      stopLoop();
      mark(wordAtChar(slots, charIndex));
    },
    /** The voice finished (or was stopped): clear the mark; a real finish teaches the pace. */
    end(finished = false) {
      if (done) return;
      done = true;
      stopLoop();
      if (finished && started >= 0)
        learnPace(lang, sentenceUnits(text, lang) / (rate || 1), (d.now() - started) / 1000);
      out(null);
    },
  };
}
