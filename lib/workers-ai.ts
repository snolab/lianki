/**
 * Cloudflare Workers AI — the app's LLM and TTS provider.
 *
 * Chat and embeddings go through Cloudflare's **OpenAI-compatible** endpoint, so
 * the `openai` SDK and `@ai-sdk/openai` both work with nothing but a `baseURL`
 * swap. That is deliberate: `workers-ai-provider@4` (the native AI SDK provider)
 * requires `ai@^7` and `@ai-sdk/*@^4`, while this app is on `ai@6` — adopting it
 * would drag a major SDK upgrade into an unrelated change.
 *
 * TTS is NOT part of that compatibility layer and uses the native
 * `/ai/run/<model>` endpoint, which returns binary MP3.
 *
 * Production runs on Vercel (behind Cloudflare's proxy), not on Workers, so
 * there is no `env.AI` binding to bind to — these are REST calls authenticated
 * with an account-scoped API token.
 */

import { createOpenAI } from "@ai-sdk/openai";
import OpenAI from "openai";

/** Replaces gpt-4o-mini: the everyday model for short, cheap generations. */
export const textModel = () =>
  process.env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Replaces gpt-4o, for work where output quality is worth the latency. */
export const textModelHq = () => process.env.WORKERS_AI_MODEL_HQ || "@cf/openai/gpt-oss-120b";

export const speechModel = () => process.env.WORKERS_AI_TTS_MODEL || "@cf/myshell-ai/melotts";

const accountId = () => process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
// CLOUDFLARE_API_TOKEN is what wrangler already uses; the AI-specific name wins
// so a token can be scoped to Workers AI alone without touching deploys.
const apiToken = () =>
  (process.env.CLOUDFLARE_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN)?.trim() || "";

export const isWorkersAiConfigured = () => Boolean(accountId() && apiToken());

/** Missing-config message shared by every route, so the fix is unambiguous. */
export const WORKERS_AI_NOT_CONFIGURED =
  "Workers AI is not configured: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN";

const apiBase = () => `https://api.cloudflare.com/client/v4/accounts/${accountId()}/ai`;

function requireConfig() {
  if (!isWorkersAiConfigured()) throw new Error(WORKERS_AI_NOT_CONFIGURED);
  return { accountId: accountId(), apiToken: apiToken() };
}

/** Drop-in for `new OpenAI({ apiKey })` — same client, different origin. */
export function workersAiOpenAI(): OpenAI {
  const { apiToken } = requireConfig();
  return new OpenAI({ apiKey: apiToken, baseURL: `${apiBase()}/v1` });
}

/** Drop-in for the `openai` import from `@ai-sdk/openai`. */
export function workersAiProvider() {
  const { apiToken } = requireConfig();
  return createOpenAI({ apiKey: apiToken, baseURL: `${apiBase()}/v1` });
}

/**
 * MeloTTS language codes. The TTS routes only ever received `text`, never a
 * language — OpenAI's tts-1 inferred it from the input — so guess from the
 * script rather than defaulting everything to English, which would make
 * Japanese and Chinese output unusable.
 *
 * Order matters: kana and Hangul are decisive, and are checked before the Han
 * range that Japanese also draws on.
 */
/** MeloTTS ships one voice per language; anything else falls back to guessing. */
const MELOTTS_LANGS = new Set(["en", "es", "fr", "zh", "ja", "ko"]);

/**
 * Resolve the language to synthesize in. An explicit locale from the caller
 * wins — several clients already send one, and it beats guessing — but a
 * region-tagged or unsupported value falls back to the script heuristic rather
 * than being passed through to a model that would reject it.
 */
export function resolveTtsLang(text: string, locale?: string): string {
  const base = locale?.trim().toLowerCase().split(/[-_]/)[0];
  if (base && MELOTTS_LANGS.has(base)) return base;
  return guessTtsLang(text);
}

export function guessTtsLang(text: string): string {
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja"; // hiragana / katakana
  if (/[가-힯ᄀ-ᇿ]/.test(text)) return "ko"; // hangul
  if (/[一-鿿㐀-䶿]/.test(text)) return "zh"; // han
  return "en";
}

/**
 * Generate speech. Returns MP3 bytes.
 *
 * MeloTTS takes only `prompt` and `lang` — there is no voice or speed control,
 * unlike tts-1. Callers that still pass a voice keep working; the value is
 * ignored here rather than silently changing what they hear, and the caller is
 * responsible for not promising the user a voice choice that no longer exists.
 */
export async function workersAiSpeech(opts: {
  text: string;
  lang?: string;
  signal?: AbortSignal;
}): Promise<Buffer<ArrayBuffer>> {
  const { apiToken } = requireConfig();
  const lang = opts.lang || guessTtsLang(opts.text);

  const res = await fetch(`${apiBase()}/run/${speechModel()}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: opts.text, lang }),
    signal: opts.signal,
  });

  if (!res.ok) {
    // Cloudflare returns its error envelope as JSON even for a binary endpoint;
    // surfacing its text is the difference between "500" and a fixable message.
    const detail = await res.text().catch(() => "");
    throw new Error(`Workers AI TTS failed (HTTP ${res.status}) ${detail.slice(0, 500)}`);
  }

  // Binary MP3 for a success. A JSON body here means the model returned an
  // error envelope with a 200, which the audio path would otherwise hand to the
  // browser as a corrupt file.
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await res.text();
    throw new Error(`Workers AI TTS returned JSON, not audio: ${body.slice(0, 500)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
