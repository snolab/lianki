/**
 * The silence guard: lines a speech model made up over silence or noise never
 * reach the chat (docs/workers-ai.md, "Silence guard"). Pure: one engine, and
 * all that varies by language or by model is data in this file. What each
 * number rests on is written next to it.
 */

/**
 * What a route answered besides the text. Each route fills in what it really
 * has (measured 2026-11-06, docs/workers-ai.md): nothing is assumed.
 */
export type SttSignals = {
  /**
   * How the text was decoded. "whisper" is autoregressive: it can write whole
   * sentences no one said. "ctc" (SenseVoice) emits per frame: on non-speech it
   * writes a stray word, and it never once wrote a stock phrase.
   */
  decoder?: "whisper" | "ctc";
  /**
   * Mean log probability of the decoded tokens, weighted by segment length.
   * Logged for tuning; no gate reads it: real speech and noise overlap (owner
   * −3.71…−0.05, noise −1.15…−0.21 on turbo). Whisper's other signal,
   * no_speech_prob, is not here at all: large-v3-turbo said 0 on every clip,
   * speech or noise, on Workers AI and on mlx-whisper alike.
   */
  logprob?: number;
  /** The share of the audio the route's own VAD kept as speech, 0–1 (cloud turbo). */
  vadShare?: number;
};

/**
 * A known phrase. `…` stands for a short run of anything (SLOT characters at
 * most), never at the start: a phrase must open the line, or any sentence
 * ending in it would be one.
 */
export type StockPhrase = {
  text: string;
  /**
   * "credit": a channel, subtitle or transcription credit, which no one says
   * as a whole line to a chat. From a Whisper decoder it is dropped on the
   * words alone: three of the five 请不吝… measured on café noise came with
   * 3.9–4.9 s of "speech" at a mean probability over 0.6 and a good logprob,
   * so no weak evidence would have caught them.
   * "courtesy": what a person may really say. Dropped only with weak evidence
   * that it was not speech. So is a credit from a decoder that does not make
   * them up (ctc).
   */
  kind: "credit" | "courtesy";
};

const credit = (...t: string[]): StockPhrase[] => t.map((text) => ({ text, kind: "credit" }));
const courtesy = (...t: string[]): StockPhrase[] => t.map((text) => ({ text, kind: "courtesy" }));

/**
 * The phrases: Simplified where Chinese (Traditional folds onto it). A pattern
 * whose slot could be ordinary prose ("Subtitles by default…") is a courtesy,
 * however credit-like it reads; a credit must be unmistakable. "Measured":
 * came out of a model here on non-speech clips (docs/workers-ai.md); the rest
 * are long-standing public reports of the same training-data credits.
 *
 * Not listed, though the fallback model says them on noise: "Thank you",
 * "Thank you very much", 수고하셨습니다. Each is short and everyday, so the
 * weak evidence below would drop the real thing too.
 */
export const STOCK_PHRASES: readonly StockPhrase[] = [
  // zh. Measured on turbo: 请不吝…明镜与点点栏目, 中文字幕志愿者 李宗盛; on mlx-whisper:
  // 字幕提供者 李宗盛, 中文字幕 李宗盛. Field (the owner, 2026-11-06): 明镜需要您的支持.
  ...credit(
    "请不吝点赞…",
    "明镜与点点栏目",
    "打赏支持明镜与点点栏目",
    "明镜需要您的支持",
    "字幕志愿者…",
    "中文字幕志愿者…",
    "文字幕志愿者…",
    "字幕…李宗盛",
    "中文字幕…李宗盛",
    "文字幕…李宗盛",
    "优优独播剧场…",
    "字幕由Amara.org社区提供",
    "小编字幕由Amara.org社区提供",
    "由Amara.org社区提供的字幕",
  ),
  ...courtesy(
    "谢谢观看",
    "感谢观看",
    "感谢收看",
    "谢谢收看",
    "谢谢您的观看",
    "感谢您的观看",
    "请订阅",
    "订阅我的频道…",
    "字幕由…提供",
    "由…提供的字幕",
    "字幕提供",
    "中文字幕提供",
    "字幕制作…",
  ),
  // ja. Measured on the fallback model: ご視聴…, チャンネル登録…; on mlx-whisper: 字幕作成者 李宗盛.
  ...credit("字幕作成者…"),
  ...courtesy(
    "ご視聴ありがとうございました",
    "ご清聴ありがとうございました",
    "ご視聴いただきありがとうございました",
    "最後までご視聴いただきありがとうございました",
    "チャンネル登録よろしくお願いします",
    "チャンネル登録をお願いします",
    "チャンネル登録をお願いいたします",
    "次回もお楽しみに",
    "おやすみなさい",
  ),
  // ko. Measured on the fallback model: MBC 뉴스 ….
  ...credit("MBC 뉴스…입니다", "한글자막…"),
  ...courtesy("시청해주셔서 감사합니다", "구독과 좋아요 부탁드립니다", "자막 제공…"),
  // en. Measured on the fallback model: every "…for watching", "…in the next video".
  ...credit("Transcribed by https…", "Subtitles by the Amara.org community"),
  ...courtesy(
    "Thanks for watching",
    "Thank you for watching",
    "Thank you so much for watching",
    "Thank you very much for watching",
    "Thanks for watching see you in the next video…",
    "Thank you so much for watching see you in the next video…",
    "I'll see you in the next video…",
    "See you in the next video…",
    "Please subscribe",
    "Don't forget to like and subscribe…",
    "Subtitles by …",
    "Transcribed by …",
  ),
  // Others of the same family. Measured on the fallback model: Редактор субтитров ….
  ...credit("Редактор субтитров …", "Субтитры сделал …", "Субтитры создавал …"),
  ...courtesy(
    "Sous-titres réalisés par …",
    "Sous-titrage …",
    "Untertitel …",
    "Untertitelung …",
    "Subtítulos realizados por …",
    "Subtítulos por …",
    "Legendas pela …",
    "Sottotitoli creati …",
    "Ondertiteling …",
    "Merci d'avoir regardé…",
    "Vielen Dank fürs Zuschauen",
    "Gracias por ver el video",
    "Obrigado por assistir",
    "Grazie per la visione",
    "Bedankt voor het kijken",
    "Спасибо за просмотр",
  ),
];

/**
 * The gates, all in one place (docs/workers-ai.md, "Silence guard", has the
 * measurements). 211 of the owner's clips, read only, stand for real speech;
 * 120 windows of recorded café, restaurant and traffic noise (DEMAND) and 82
 * generated non-speech clips stand for the rest.
 */
export const STT_GUARD = {
  /**
   * Under this, the loudest 32 ms frame of the clip is no speech. The owner's
   * quietest clip of 211 peaks at 0.0101, so this is about 2 dB below all real
   * speech seen. A silent mic hallucinates too (the fallback model did on
   * every generated silence), and Silero is level-blind (docs/stt-ab.md).
   */
  minFrameRms: 0.008,
  /**
   * Under this much Silero speech (one 32 ms frame), no frame looked like speech
   * at all. All 211 of the owner's clips reach it. It stays this low because real
   * single words are as faint as noise (docs/stt-ab.md): it never sorts speech
   * from noise, only nothing from something. The energy VAD gives no
   * probabilities, and then this gate does not run.
   */
  minSpeechMs: 32,
  /**
   * Under this share of the clip kept by cloud turbo's own VAD, there is too
   * little speech for a line. Lowest on the owner's clips with text: 0.295;
   * noise that still gave text went down to 0.108.
   */
  minVadShare: 0.25,
  /** Weak evidence, for a stock phrase only: under this much speech (the mic's, field-tuned 2026-10). */
  shortSpeechMs: 1_200,
  /** Weak evidence, for a stock phrase only: under this mean speech probability. */
  faintProb: 0.5,
} as const;
export type SttGuardLimits = { [K in keyof typeof STT_GUARD]: number };

/** What the mic knows of one final, for the gates. */
export type SttEvidence = {
  /** Silero speech in the utterance; without probabilities, its whole length. */
  speechMs: number;
  /** Silero's mean probability over it; undefined when the energy VAD ran instead. */
  prob?: number;
  /** The loudest 32 ms frame's RMS, full scale 1. */
  frameRms?: number;
  signals?: SttSignals;
};

/** Why a line was dropped. No text: this is what is logged. */
export type SttDropReason =
  | "silent-audio"
  | "no-speech-frames"
  | "route-vad"
  | "stock-credit"
  | "stock-courtesy";

/** The characters a `…` may stand for: "the Amara.org community" fits, a paragraph does not. */
const SLOT = 40;
/** Longer than this (normalized) is no stock phrase, however it starts. */
const MAX_PHRASE = 160;

/**
 * Traditional characters folded onto Simplified, for the characters of the
 * phrases above. The text and the phrases go through the same fold, so a
 * Japanese 視聴 is folded on both sides and still matches.
 */
const HAN_FOLD: Readonly<Record<string, string>> = {
  謝: "谢",
  觀: "观",
  視: "视",
  訂: "订",
  閱: "阅",
  轉: "转",
  發: "发",
  贊: "赞",
  讚: "赞",
  點: "点",
  鏡: "镜",
  與: "与",
  欄: "栏",
  請: "请",
  製: "制",
  願: "愿",
  頻: "频",
  優: "优",
  獨: "独",
  劇: "剧",
  場: "场",
  賞: "赏",
  語: "语",
};
const foldHan = (s: string) => [...s].map((c) => HAN_FOLD[c] ?? c).join("");
const UNFOLD: Readonly<Record<string, string>> = Object.entries(HAN_FOLD).reduce<
  Record<string, string>
>((m, [t, s]) => ({ ...m, [s]: (m[s] ?? "") + t }), {});

/** For matching: NFKC, lowercased, without punctuation, symbols or whitespace. */
export function normalizeTranscript(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}
/** The form phrases are compared in: normalized, Traditional folded onto Simplified. */
export const phraseKey = (s: string) => foldHan(normalizeTranscript(s));

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regex for phraseKey'd text that is one of `list`, or a run of them. */
export const wholePhraseRe = (list: readonly string[]) =>
  new RegExp(
    `^(?:${list
      .map((h) =>
        h
          .split("…")
          .map((part) => escapeRe(phraseKey(part)))
          .join(`.{0,${SLOT}}`),
      )
      .join("|")})+$`,
    "u",
  );

/** Punctuation, symbols or spaces, anywhere between a phrase's characters. */
export const GAP = "[\\p{P}\\p{S}\\s]*";
/** One phrase on raw text: each character in turn, either script, any punctuation or spacing between. */
export const looseAlternative = (h: string) =>
  h
    .split("…")
    .map((part) =>
      [...phraseKey(part)].map((c) => (UNFOLD[c] ? `[${c}${UNFOLD[c]}]` : escapeRe(c))).join(GAP),
    )
    .join(`.{0,${SLOT}}?`);

const credits = STOCK_PHRASES.filter((p) => p.kind === "credit").map((p) => p.text);
const CREDIT_RE = wholePhraseRe(credits);
const ANY_RE = wholePhraseRe(STOCK_PHRASES.map((p) => p.text));

/** Which stock phrase the whole text is, if it is one: credit when only credits make it up. */
export function stockPhraseKind(text: string): StockPhrase["kind"] | undefined {
  const k = phraseKey(text);
  if (!k || k.length > MAX_PHRASE || !ANY_RE.test(k)) return undefined;
  return CREDIT_RE.test(k) ? "credit" : "courtesy";
}

/** The loudest `frame`-sample RMS of a clip (32 ms at 16 kHz). */
export function loudestFrameRms(audio: Float32Array, frame = 512): number {
  let best = 0;
  for (let at = 0; at < audio.length; at += frame) {
    const end = Math.min(at + frame, audio.length);
    let sum = 0;
    for (let i = at; i < end; i++) sum += audio[i] * audio[i];
    best = Math.max(best, sum / (end - at));
  }
  return Math.sqrt(best);
}

/**
 * Keep this final, or say why not (null: keep). It runs before the chat, the
 * command taps, the send and its cue, and the polish: all of those hear only
 * what passes here. A line with no audio behind it is dropped whatever it says.
 *
 * A real sentence holding a stock phrase ("他说感谢观看这个视频的人", "Thanks
 * for watching my talk") is not one: the whole line, normalized, must be the
 * phrase (or a run of them).
 */
export function judgeFinal(
  text: string,
  e: SttEvidence,
  g: SttGuardLimits = STT_GUARD,
): SttDropReason | null {
  if (!normalizeTranscript(text)) return null;
  if (e.frameRms !== undefined && e.frameRms < g.minFrameRms) return "silent-audio";
  if (e.prob !== undefined && e.speechMs < g.minSpeechMs) return "no-speech-frames";
  const s = e.signals;
  if (s?.vadShare !== undefined && s.vadShare < g.minVadShare) return "route-vad";
  const kind = stockPhraseKind(text);
  if (!kind) return null;
  if (kind === "credit" && s?.decoder !== "ctc") return "stock-credit";
  const weak = e.speechMs < g.shortSpeechMs || (e.prob !== undefined && e.prob < g.faintProb);
  return weak ? (kind === "credit" ? "stock-credit" : "stock-courtesy") : null;
}
