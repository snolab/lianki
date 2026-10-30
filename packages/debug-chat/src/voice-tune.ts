/**
 * The mic's tunables, from the VAD A/B on the owner's real clips (#357),
 * and two rules on its finals:
 *
 * - VAD: Silero's thresholds and timings (MicButton passes them to
 *   MicVAD.new). minSpeechMs 250 (was 400) keeps short answers;
 *   preSpeechPadMs 800 keeps the start of a word.
 * - JOIN: 18 of 93 dictated lines were the second half of a sentence cut at
 *   the 600 ms endpoint. A spoken final is held up to joinMs before it is
 *   sent; speech starting again in that time cancels the send, and the next
 *   final joins the same line (the draft). A 2.5 s join rejoins about 17.
 * - Blips: a final that is a single short Latin word or only 嗯/呃 is
 *   dropped, except short answers (yes, no, ok, …, 是, 不, 行, はい, …).
 *
 * Tune: edit TUNE here with the widget hot-loaded, or set
 * `globalThis.__lkVoiceTune = { joinMs: 1500 }` on the page (read each time
 * it is used) to try a value without a rebuild.
 */
/** Fired on window when the mic starts capturing speech (a held line waits for it). */
export const VOICE_CAPTURE_EVENT = "lk:voice-capture";

export type VoiceTune = {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  preSpeechPadMs: number;
  redemptionMs: number;
  /** How long a spoken final waits for more speech before it is sent; 0 = at once. */
  joinMs: number;
};
export const VOICE_TUNE: VoiceTune = {
  positiveSpeechThreshold: 0.3,
  negativeSpeechThreshold: 0.25,
  minSpeechMs: 250,
  preSpeechPadMs: 800,
  redemptionMs: 1400,
  // Off by default (owner, 03:28: "send as soon as possible"); 2500 rejoins ~17 of 18 cut lines.
  joinMs: 0,
};

/** The defaults with the page's overrides (finite, non-negative numbers only). */
export function voiceTune(
  over: unknown = (globalThis as { __lkVoiceTune?: unknown }).__lkVoiceTune,
): VoiceTune {
  const t = { ...VOICE_TUNE };
  if (over && typeof over === "object")
    for (const k of Object.keys(t) as (keyof VoiceTune)[]) {
      const v = (over as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) t[k] = v;
    }
  return t;
}

/** Short answers that always pass the blip guard. */
const SHORT_ANSWERS = new Set([
  "yes",
  "no",
  "ok",
  "okay",
  "good",
  "stop",
  "next",
  "thanks",
  "是",
  "不",
  "行",
  "はい",
  "いいえ",
  "どうぞ",
]);

/**
 * A final not worth a line of its own: a single Latin word of at most 8
 * letters (a cough, a "hmm", half a word), or only 嗯/呃 — unless it is one
 * of the short answers.
 */
export function isBlip(text: string): boolean {
  const t = text
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .toLowerCase();
  if (!t) return true;
  if (SHORT_ANSWERS.has(t)) return false;
  if (/^[嗯呃]+$/u.test(t)) return true;
  // One word only: "go on" is two.
  const words = text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length === 1 && /^[a-z]{1,8}$/.test(t);
}

/**
 * The join: one held send at a time. `final()` holds a spoken line's send
 * for joinMs (or sends at once with joinMs 0); `speechStart()` cancels a
 * held send (the next final will join the line); `idle()` re-holds it when
 * the speech came to nothing (a misfire, a dropped blip); `flush()` sends
 * now; `cancel()` forgets it (the line went out another way).
 */
export function createJoiner(d: {
  send: () => void;
  joinMs: () => number;
  setTimer: (f: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}) {
  let timer: unknown = null;
  /** A line is waiting to go (held, or cancelled by new speech). */
  let waiting = false;
  const clear = () => {
    if (timer !== null) d.clearTimer(timer);
    timer = null;
  };
  const go = () => {
    clear();
    if (!waiting) return;
    waiting = false;
    d.send();
  };
  const hold = () => {
    clear();
    waiting = true;
    const ms = d.joinMs();
    if (ms <= 0) return go();
    timer = d.setTimer(go, ms);
  };
  return {
    final: hold,
    speechStart() {
      // More speech: no send yet; the next final joins this line.
      if (waiting) clear();
    },
    idle() {
      if (waiting && timer === null) hold();
    },
    flush: go,
    cancel() {
      clear();
      waiting = false;
    },
    /** A line is held or waiting for more speech. */
    waiting: () => waiting,
  };
}
