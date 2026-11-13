/**
 * What every paid provider call costs, as data — the one table
 * (docs/payments.md, "What costs credits"). Owner, 2026-11-09: "every paid
 * service must run on the USER's credits".
 *
 * Provider list prices in USD (Cloudflare Workers AI pricing page, read
 * 2026-11-09), times `MARGIN`, become credits at `CREDITS_PER_USD`
 * (lib/payments/credits.ts). Change a price here and every charge follows.
 *
 * No I/O, no imports from the app: unit-testable and safe for any bundle.
 */

/**
 * This table's version. A feature paused after an overage
 * (lib/payments/metered.ts) stays paused only while this is unchanged: bump it
 * with any price or ceiling change, and the deploy un-pauses everything.
 */
export const PRICES_VERSION = "2026-11-11";

/** Our price over the provider's list price (covers fees, retries, rounding). */
export const MARGIN = 1.5;

/** USD per million tokens, input and output, by model id. */
export const TEXT_PRICES: Readonly<Record<string, { inPerM: number; outPerM: number }>> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 0.293, outPerM: 2.253 },
  "@cf/openai/gpt-oss-120b": { inPerM: 0.35, outPerM: 0.75 },
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": { inPerM: 0.3, outPerM: 1.2 },
};
/** A model missing from the table (an env override) is priced as the dearest one listed. */
export const FALLBACK_TEXT_PRICE = { inPerM: 0.35, outPerM: 2.253 };

/** MeloTTS: USD per audio minute. */
export const MELOTTS_USD_PER_MIN = 0.0002;
/** Deepgram Aura-2 (a lane's own voice): USD per 1,000 input characters. */
export const AURA2_USD_PER_KCHAR = 0.03;
/**
 * Provider voices (`voice.cloud`, lib/cloud-voices.ts): USD per million
 * billed characters, by tier, from the providers' list prices (read
 * 2026-11-11). Where a page and an older figure disagree (Google WaveNet: $4
 * on the page, $16 before), the higher one, so a hold always covers the bill.
 */
export const PROVIDER_TTS_USD_PER_M = {
  "google:standard": 4,
  "google:wavenet": 16,
  "google:neural2": 16,
  "google:chirp": 30,
  "google:studio": 160,
  "azure:neural": 16,
  "azure:hd": 30,
} as const;
export type ProviderTier = keyof typeof PROVIDER_TTS_USD_PER_M;

/** A provider voice's price tier, by its name; a name not recognised is the dearest of its provider. */
export function providerTier(provider: "google" | "azure", name: string): ProviderTier {
  const n = name.toLowerCase();
  if (provider === "azure") return /dragonhd|-hd|:hd/.test(n) ? "azure:hd" : "azure:neural";
  if (n.includes("-standard-")) return "google:standard";
  if (n.includes("-wavenet-")) return "google:wavenet";
  if (/-(neural2|polyglot|news)-/.test(n)) return "google:neural2";
  if (n.includes("-chirp")) return "google:chirp";
  return "google:studio";
}

/** Our USD price for `chars` billed characters in a provider voice. */
export const providerTtsUsd = (provider: "google" | "azure", name: string, chars: number) =>
  (Math.max(0, chars) / 1e6) * PROVIDER_TTS_USD_PER_M[providerTier(provider, name)] * MARGIN;

/** Whisper large-v3-turbo (the default STT): USD per audio minute; the fallback is cheaper. */
export const STT_USD_PER_MIN = 0.000513;

/**
 * Ceilings used to hold before a call (a hold is the most a call can cost; the
 * settle refunds the rest):
 * - tokens per character of input (Latin ~0.3, CJK ~1, emoji up to ~2);
 * - seconds of speech per character (slow speech is ~6 chars/s; this is 3);
 * - seconds of audio per byte of an upload (Opus voice at ≥ 16 kbit/s; WAV is
 *   far more bytes per second, so it is over-held, never under-held).
 */
export const HOLD_TOKENS_PER_CHAR = 2;
/** Input tokens held per attached image (a large image is ~1,500 tokens). */
export const HOLD_TOKENS_PER_IMAGE = 4000;
export const HOLD_SPEECH_SEC_PER_CHAR = 1 / 3;
export const HOLD_AUDIO_SEC_PER_BYTE = 1 / 2000;
/** The actual audio length of a clip, when only the text is known: ~6 characters a second. */
export const SPEECH_SEC_PER_CHAR = 1 / 6;

/** Every feature that spends credits — its id is the ledger row's `note` (the usage view's label). */
export const FEATURES = [
  "partner.reply",
  "chat.prepare",
  "voice.auto-polish",
  "read.gloss",
  "read.polish",
  "read.live-polish",
  "read.translate",
  "vibe.translate",
  "self-intro.followup",
  "self-intro.import",
  "self-intro.translate",
  "self-intro.tts",
  "words.tts",
  "speech.stt",
  "ai-sentences",
  "polyglot.translate",
  "polyglot.tts",
  "roadmap.generate",
  "blog.translate",
  "words.import-ai",
  "tts",
  "voice.cloud",
] as const;
export type Feature = (typeof FEATURES)[number];

const price = (model: string) => TEXT_PRICES[model] ?? FALLBACK_TEXT_PRICE;

/** Our USD price for a text call's tokens. */
export const textUsd = (model: string, tokensIn: number, tokensOut: number) => {
  const p = price(model);
  return ((Math.max(0, tokensIn) * p.inPerM + Math.max(0, tokensOut) * p.outPerM) / 1e6) * MARGIN;
};

/** The most a text call can cost: `chars` of prompt (and `images`), `maxOut` tokens of answer. */
export const textHoldUsd = (model: string, chars: number, maxOut: number, images = 0) =>
  textUsd(
    model,
    Math.ceil(Math.max(0, chars) * HOLD_TOKENS_PER_CHAR) +
      Math.max(0, images) * HOLD_TOKENS_PER_IMAGE,
    maxOut,
  );

/** Our USD price for `seconds` of MeloTTS audio. */
export const melottsUsd = (seconds: number) =>
  (Math.max(0, seconds) / 60) * MELOTTS_USD_PER_MIN * MARGIN;
/** Our USD price for `chars` of Aura-2 speech. */
export const aura2Usd = (chars: number) =>
  (Math.max(0, chars) / 1000) * AURA2_USD_PER_KCHAR * MARGIN;

/** The most a clip of `chars` can cost (Aura-2 when a speaker is asked, else MeloTTS). */
export const speechHoldUsd = (chars: number, aura = false) =>
  aura ? aura2Usd(chars) : melottsUsd(chars * HOLD_SPEECH_SEC_PER_CHAR);
/** What a clip of `chars` cost (no duration is reported: estimated from its length). */
export const speechUsd = (chars: number, aura = false) =>
  aura ? aura2Usd(chars) : melottsUsd(chars * SPEECH_SEC_PER_CHAR);

/** Our USD price for transcribing an upload of `bytes` (its length estimated from its size). */
export const sttUsd = (bytes: number) =>
  ((Math.max(0, bytes) * HOLD_AUDIO_SEC_PER_BYTE) / 60) * STT_USD_PER_MIN * MARGIN;
