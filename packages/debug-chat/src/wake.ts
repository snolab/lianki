/**
 * The wake word "Linky" (docs/wake-word.md): a gate before speech-to-text.
 *
 * Active: every utterance goes to STT and the agent, as before. Passive: the
 * phone spots "Linky" on-device (wake-kws.ts, sherpa-onnx KWS in WASM) in
 * each VAD segment, and nothing is uploaded until it hears it. Utterances
 * that are clearly not for the agent (empty or hallucinated transcripts, or
 * the agent saying "not for me") move it to passive after REJECTS_TO_PASSIVE
 * in a row; "Linky", a tap on the mic or the agent move it back.
 *
 * Pure, so it is tested without a browser (unit/wake.test.ts).
 */

export type WakeMode = "active" | "passive";
/** Why the mode changed (the `{ev: "wake"}` log line). */
export type WakeReason =
  | "rejects" // REJECTS_TO_PASSIVE rejected utterances in a row
  | "wake-word" // "Linky" heard in passive mode
  | "tap" // the mic button tapped while passive
  | "agent" // the chat lane set it ({type: "wake"})
  | "kws-failed" // the spotter could not load: back to active, never deaf
  | "mic-on"; // listening turned on: always starts active

/** Rejected utterances in a row that make the mic passive. */
export const REJECTS_TO_PASSIVE = 3;

/** One pronunciation of the wake word, as model tokens (tokens.txt of the zh-en model). */
export type KeywordMatch = { tokens: string[]; score?: number; threshold?: number };
export type KeywordEntry = {
  label: string;
  matches: KeywordMatch[];
  score?: number;
  threshold?: number;
};

/**
 * "Linky" for kws-zipformer-zh-en-3M-2025-12-20 (CMU phones for English,
 * toned pinyin for Chinese). The variants are the accents measured in
 * docs/wake-word.md: English, "lin-kii" without ŋ (Chinese and Japanese
 * speakers), and the readings 林琪 / lín kì. Threshold 0.25 / score 1.0: the
 * measured setting with no false accept on his clips or the agent's TTS.
 */
export const LINKY: KeywordEntry = {
  label: "LINKY",
  score: 1,
  threshold: 0.25,
  matches: [
    { tokens: ["L", "IH1", "NG", "K", "IY0"] },
    { tokens: ["L", "IH1", "NG", "K", "IY1"] },
    { tokens: ["L", "IH1", "N", "K", "IY1"] },
    { tokens: ["l", "ín", "k", "ì"] },
    { tokens: ["l", "ín", "q", "í"] },
  ],
};

/** A detection, as the spotter reports it (seconds within the segment). */
export type Detection = { label: string; startTime: number; timestamps: number[]; tokens: string[] };

/**
 * Seconds after the last token's timestamp where the words after "Linky"
 * begin. The transducer reports the last token late, at about the keyword's
 * end: measured in Chromium (scripts/dev/wake-word-qa.mjs --save), a cut at
 * +0.25 s lost "what's" of "Linky, what's next?", a cut at 0 sent exactly
 * "What's next?". Cutting early leaves a bit of "-ky", which STT ignores;
 * cutting late loses words.
 */
export const KEYWORD_TAIL_S = 0;
/** What is left after "Linky" shorter than this is no request: a bare wake. */
export const MIN_REQUEST_MS = 400;

/** Where the keyword ends, in seconds within the segment the spotter was given. */
export function keywordEnd(d: Detection): number {
  const last = d.timestamps.length ? Math.max(...d.timestamps) : 0;
  return d.startTime + last + KEYWORD_TAIL_S;
}

/**
 * The spotter's verdict on one utterance: no wake word, or the wake word and
 * what was said after it (`rest`: empty for a bare "Linky").
 */
export type WakeSpot = { hit: false } | { hit: true; rest: Float32Array; tokens: string[] };

/** The samples after the first detection's keyword (`pad` samples of silence were put in front). */
export function afterKeyword(
  audio: Float32Array,
  hits: Detection[],
  rate: number,
  pad = 0,
): WakeSpot {
  if (!hits.length) return { hit: false };
  const first = hits.reduce((a, b) => (keywordEnd(b) < keywordEnd(a) ? b : a));
  const from = Math.max(0, Math.round(keywordEnd(first) * rate) - pad);
  const rest = audio.subarray(Math.min(from, audio.length));
  const ms = (rest.length / rate) * 1000;
  return { hit: true, rest: ms < MIN_REQUEST_MS ? new Float32Array(0) : rest, tokens: first.tokens };
}

export type WakeView = { mode: WakeMode; rejects: number };

/**
 * The active/passive state machine. `reject` counts an utterance that was not
 * for the agent, `accept` one that was (it resets the count); `set` is the
 * wake word, a tap, the agent, or listening turning on.
 */
export function createWake(o: {
  onChange?: (v: WakeView, from: WakeMode, reason: WakeReason) => void;
  rejectsToPassive?: number;
} = {}) {
  const limit = o.rejectsToPassive ?? REJECTS_TO_PASSIVE;
  let mode: WakeMode = "active";
  let rejects = 0;
  const view = (): WakeView => ({ mode, rejects });
  const set = (to: WakeMode, reason: WakeReason) => {
    rejects = 0;
    if (to === mode) return false;
    const from = mode;
    mode = to;
    o.onChange?.(view(), from, reason);
    return true;
  };
  return {
    mode: () => mode,
    view,
    set,
    /** An utterance that was not for the agent; returns true if this made it passive. */
    reject() {
      if (mode !== "active") return false;
      rejects++;
      return rejects >= limit ? set("passive", "rejects") : false;
    },
    /** An utterance that was for the agent. */
    accept() {
      rejects = 0;
    },
  };
}
export type Wake = ReturnType<typeof createWake>;

/** What the chat lane may send ({type: "wake", mode}): "ignored" counts one rejection. */
export type WakeCommand = WakeMode | "ignored";
export const isWakeCommand = (v: unknown): v is WakeCommand =>
  v === "active" || v === "passive" || v === "ignored";
