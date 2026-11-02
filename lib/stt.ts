/**
 * Speech to text for the debug chat's mic (docs/workers-ai.md, "Speech to
 * text"): which Workers AI models may be asked for, what they cost, and how
 * their answers are read. Shared by /api/debug/stt and the STT bench. No I/O.
 */
import { STT_PROMPT, STT_PROMPT_ZH } from "@lianki/debug-chat/stt-hint";

/**
 * The Workers AI ASR models that take one audio file over REST, from
 * `wrangler ai models` (2026-10-29). @cf/deepgram/flux is websocket-only and
 * @cf/openai/whisper-tiny-en is English-only (beta): neither is offered.
 */
export const STT_MODELS = [
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/openai/whisper",
  "@cf/deepgram/nova-3",
] as const;
export type SttModel = (typeof STT_MODELS)[number];

/**
 * The default. Measured against the live API on 2026-10-29 with the word
 * lists' recorded sentences (docs/workers-ai.md, "Speech to text"): it was
 * exact on Japanese, Chinese and English alone, and on one clip switching
 * ja → en → zh it kept all three (with STT_PROMPT). It is also the cheapest.
 */
export const DEFAULT_STT_MODEL: SttModel = "@cf/openai/whisper-large-v3-turbo";
/**
 * Tried once when the default fails. The original Whisper is weaker (it
 * writes Chinese in traditional characters and misses words) but it covers
 * all three languages. Nova-3 is not the fallback: on Workers AI it has no
 * Chinese at all (`language=zh` is refused, `multi` answers ""), and in a
 * mixed clip it kept only the English.
 */
export const FALLBACK_STT_MODEL: SttModel = "@cf/openai/whisper";

/**
 * whisper-large-v3-turbo's `initial_prompt` when no language is given. Whisper
 * settles on one language per window; a prompt that itself switches scripts
 * makes it keep switching. Without it, a ja + en clip came back English only.
 * It does not leak into silence (tested: "" for 2 s of noise).
 */
export { STT_PROMPT };

/** The languages a mic may hint (`?hint=`): the one the speaker mostly uses. */
export const STT_HINTS = ["zh", "ja", "en"] as const;
export type SttHint = (typeof STT_HINTS)[number];
export const sttHint = (raw: string | null | undefined): SttHint | undefined =>
  (STT_HINTS as readonly string[]).includes(raw ?? "") ? (raw as SttHint) : undefined;

/**
 * The prompt for a hinted language. A hint is softer than `?lang=`: Whisper
 * still detects per window, and the prompt only says which language leads.
 * On the owner's 12 saved clips (2026-10-30), a Chinese-led prompt in
 * simplified characters beat STT_PROMPT on every Chinese clip (simplified
 * output, 銀外 → 另外, and no katakana for a short clip that came back as
 * シェイカーマイカフォン), while `language: "zh"` dropped all punctuation and
 * turned the English clips into Chinese. ja and en keep STT_PROMPT.
 */
export function sttPrompt(hint?: SttHint): string {
  return hint === "zh" ? STT_PROMPT_ZH : STT_PROMPT;
}

/**
 * USD per audio minute over REST: Cloudflare's pricing page
 * (developers.cloudflare.com/workers-ai/platform/pricing, 2026-10-29) gives
 * neurons per audio minute, at $0.011 per 1,000 neurons. The page rounds
 * both Whispers to $0.0005; these are the neuron figures worked out.
 */
export const STT_PRICE_PER_MIN: Record<SttModel, number> = {
  "@cf/openai/whisper-large-v3-turbo": 0.000513, // 46.63 neurons / min
  "@cf/openai/whisper": 0.000453, // 41.14 neurons / min
  "@cf/deepgram/nova-3": 0.0052, // 472.73 neurons / min
};

/** The audio types accepted, by Content-Type (parameters such as codecs ignored). */
export const STT_MIMES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
] as const;
export const isSttMime = (v: string) => (STT_MIMES as readonly string[]).includes(v);

/** Largest upload, in bytes (a 30 s utterance as 16 kHz WAV is ~1 MB). */
export const STT_MAX_BYTES = 2 * 1024 * 1024;

export const isSttModel = (v: unknown): v is SttModel =>
  typeof v === "string" && (STT_MODELS as readonly string[]).includes(v);

/** The model to run: the owner may pick any listed one; everyone else gets the default. */
export function pickSttModel(requested: string | null | undefined, owner: boolean): SttModel {
  return owner && isSttModel(requested) ? requested : DEFAULT_STT_MODEL;
}

/** A language hint from `?lang=`: a short BCP-47 tag, or none (detect). */
export function sttLang(raw: string | null | undefined): string | undefined {
  const v = raw?.trim();
  return v && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) ? v : undefined;
}

/**
 * Nova-3 puts a space between every Japanese word ("君 を生 かす"); drop a
 * space that has a Han, kana or CJK punctuation character on both sides.
 */
export const joinCjk = (s: string) =>
  s.replace(
    /(?<=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー、。！？]) +(?=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー、。！？])/gu,
    "",
  );

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" ? (v as Json) : undefined;

/**
 * Read a model's answer — the `result` of Cloudflare's envelope — into
 * {text, language?}. Nova-3: results.channels[0].alternatives[0].transcript
 * (and `languages`/`detected_language` when present). Whisper:
 * `text`, with `transcription_info.language` when the model reports it.
 */
export function readStt(model: SttModel, result: unknown): { text: string; language?: string } {
  const r = obj(result) ?? {};
  if (model === "@cf/deepgram/nova-3") {
    const ch = obj((obj(r.results)?.channels as unknown[] | undefined)?.[0]);
    const alt = obj((ch?.alternatives as unknown[] | undefined)?.[0]);
    const text = typeof alt?.transcript === "string" ? joinCjk(alt.transcript) : "";
    const langs = alt?.languages;
    const language =
      (Array.isArray(langs) && typeof langs[0] === "string" ? langs[0] : undefined) ??
      (typeof ch?.detected_language === "string" ? ch.detected_language : undefined);
    return language ? { text: text.trim(), language } : { text: text.trim() };
  }
  const text = typeof r.text === "string" ? r.text : "";
  const lang = obj(r.transcription_info)?.language;
  return typeof lang === "string" && lang
    ? { text: text.trim(), language: lang }
    : { text: text.trim() };
}
