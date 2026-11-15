/**
 * The repetition guard: a final transcript that is a decoding loop (Whisper or
 * SenseVoice on café noise, 2026-11-15: "あなたがウィッターウィッター…" hundreds
 * of times) is cut back to what came before the loop, or dropped when nothing
 * real is left. Pure, one engine for every script: the text is read as its
 * letters and digits only (NFKC, lowercased), so "ウィッター、ウィッター",
 * "na na na" and "nanana" are the same loop.
 *
 * Runs on every final before it is posted: the mic (mic.ts, after
 * cleanTranscript) and, for any client, the hub's owner-line path
 * (workers/push/src/debug.ts). Live limits: config stt.repeatMaxRuns,
 * stt.repeatMaxShare, stt.repeatMinKeepChars (lib/config.ts holds these
 * defaults only).
 */

export type RepeatLimits = {
  /** A unit repeated this many times in a row is a loop. 3 ("好好好", "no no no") is speech. */
  maxRuns: number;
  /** …and only when the loops cover at least this share of the text's letters. */
  maxShare: number;
  /** Less than this many letters left after the cut: the line is dropped. */
  minKeepChars: number;
};

export const STT_REPEAT: RepeatLimits = { maxRuns: 6, maxShare: 0.6, minKeepChars: 4 };

/** The longest unit, in letters, looked for inside a run of letters. A whole word may be longer. */
export const REPEAT_MAX_UNIT = 8;

export type RepeatVerdict =
  | { action: "keep"; text: string }
  | {
      action: "trim" | "drop";
      /** The cut text ("" when dropped). */
      text: string;
      /** The repeated unit, normalized (logged only by length). */
      unit: string;
      /** How many times it repeated in its first run. */
      runs: number;
      /** The share of the text's letters inside loops, 0–1. */
      share: number;
    };

/** Letters and digits; everything else (spaces, punctuation, symbols) is between them. */
const SIG = /[\p{L}\p{N}\p{M}]/u;
const DIGIT = /^\p{N}+$/u;
const WORD = /^[\p{L}\p{M}\p{N}]$/u;
/** Scripts written without spaces: their "words" are not whitespace-separated. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

type Run = { start: number; unit: number; runs: number; end: number };

/** The live limits, set by the page from config (setRepeatLimits); defaults until then. */
let live: RepeatLimits = STT_REPEAT;
/** Take config values; a missing or invalid one keeps its default. */
export function setRepeatLimits(v: Partial<Record<keyof RepeatLimits, unknown>>): void {
  live = repeatLimitsOf(v);
}
export const repeatLimits = (): RepeatLimits => live;

/** Limits from untrusted values (config reads): each must be a finite number in range. */
export function repeatLimitsOf(v: Partial<Record<keyof RepeatLimits, unknown>>): RepeatLimits {
  const num = (x: unknown, min: number, max: number, d: number) =>
    typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : d;
  return {
    maxRuns: Math.round(num(v.maxRuns, 2, 1000, STT_REPEAT.maxRuns)),
    maxShare: num(v.maxShare, 0, 1, STT_REPEAT.maxShare),
    minKeepChars: Math.round(num(v.minKeepChars, 0, 1000, STT_REPEAT.minKeepChars)),
  };
}

/** The text's letters (normalized, one per code point) and where each one ends in the raw text. */
function letters(text: string): { ch: string[]; end: number[] } {
  const ch: string[] = [];
  const end: number[] = [];
  let at = 0;
  for (const c of text) {
    at += c.length;
    if (!SIG.test(c)) continue;
    for (const n of c.normalize("NFKC").toLowerCase()) {
      if (!SIG.test(n)) continue;
      ch.push(n);
      end.push(at);
    }
  }
  return { ch, end };
}

/** Runs of a unit of 1..REPEAT_MAX_UNIT letters, at least `min` copies in a row, smallest unit first. */
function letterRuns(ch: string[], min: number): Run[] {
  const out: Run[] = [];
  for (let u = 1; u <= REPEAT_MAX_UNIT; u++) {
    let i = 0;
    while (i + u < ch.length) {
      if (ch[i] !== ch[i + u]) {
        i++;
        continue;
      }
      let j = i;
      while (j + u < ch.length && ch[j] === ch[j + u]) j++;
      // ch[i .. j+u-1] has period u.
      const runs = Math.floor((j + u - i) / u);
      const unit = ch.slice(i, i + u).join("");
      if (runs >= min && !DIGIT.test(unit)) out.push({ start: i, unit: u, runs, end: i + runs * u });
      i = j + 1;
    }
  }
  return out;
}

/** Runs of one whole word (spaced scripts), for words longer than REPEAT_MAX_UNIT. */
function wordRuns(text: string, min: number): { start: number; len: number; runs: number }[] {
  const words: { key: string; at: number }[] = [];
  let at = 0;
  for (const w of text.split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (!w) continue;
    const key = [...w.normalize("NFKC").toLowerCase()].filter((c) => WORD.test(c)).join("");
    words.push({ key, at });
    at += [...key].length;
  }
  const out: { start: number; len: number; runs: number }[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i + 1;
    while (j < words.length && words[j].key === words[i].key) j++;
    const k = words[i].key;
    const len = [...k].length;
    if (j - i >= min && len > REPEAT_MAX_UNIT && !UNSPACED.test(k) && !DIGIT.test(k))
      out.push({ start: words[i].at, len, runs: j - i });
    i = j;
  }
  return out;
}

/**
 * Keep the text, cut it to the head before its first loop (plus one copy of
 * the loop's unit), or drop it. Only a text where loops of `maxRuns` copies or
 * more cover `maxShare` of its letters is touched: a long sentence with one
 * stutter in it passes as it is.
 */
export function repeatGuard(text: string, g: RepeatLimits = live): RepeatVerdict {
  const { ch, end } = letters(text);
  if (!ch.length) return { action: "keep", text };
  const min = Math.max(2, g.maxRuns);
  const runs: Run[] = [
    ...letterRuns(ch, min),
    ...wordRuns(text, min).map((w) => ({
      start: w.start,
      unit: w.len,
      runs: w.runs,
      end: w.start + w.len * w.runs,
    })),
  ];
  if (!runs.length) return { action: "keep", text };
  const covered = new Uint8Array(ch.length);
  for (const r of runs) covered.fill(1, r.start, r.end);
  const share = covered.reduce((s, x) => s + x, 0) / ch.length;
  if (share < g.maxShare) return { action: "keep", text };
  const first = runs.reduce((a, b) =>
    b.start < a.start || (b.start === a.start && b.unit < a.unit) ? b : a,
  );
  const unit = ch.slice(first.start, first.start + first.unit).join("");
  const keepTo = first.start + first.unit;
  const cut = text.slice(0, end[keepTo - 1]).trimEnd();
  if (keepTo < g.minKeepChars) return { action: "drop", text: "", unit, runs: first.runs, share };
  return { action: "trim", text: cut, unit, runs: first.runs, share };
}
