/**
 * The pre-rendered word clips (scripts/voice), without Node: shared by the
 * Next route (app/api/words/tts) and the edge Worker in front of it
 * (workers/voice), which serves them with no session lookup.
 *
 * Clips are rendered offline into R2 under `voice/<lang>/<sha256>.mp3`. The
 * key names neither the engine nor the speaker, so re-rendering a language
 * with a better voice replaces its clips in place — browsers holding the old
 * clip keep it until their cache lapses, which is fine for a voice upgrade.
 */
export const VOICE_PREFIX = "voice/";

/** Longest text the server voices: an example sentence. */
export const MAX_TTS_TEXT = 200;

/** Languages rendered offline, and who to credit for each. */
export const VOICE_CREDITS: Record<string, string> = {
  ja: "VOICEVOX:No.7",
  en: "Kokoro",
  es: "Kokoro",
  fr: "Kokoro",
  it: "Kokoro",
  pt: "Kokoro",
  zh: "Kokoro",
  de: "Piper (Thorsten-Voice)",
  ru: "Piper (Dmitri)",
};

/** What the hash covers. Pinned: changing it orphans every clip already in R2. */
export const voiceHashInput = (lang: string, text: string) => `${lang}\n${text}`;

export const voiceKeyFromHash = (lang: string, hex: string) => `${VOICE_PREFIX}${lang}/${hex}.mp3`;

/** `voiceKey` with WebCrypto, for a Worker without Node's crypto. */
export async function voiceKeyAsync(lang: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(voiceHashInput(lang, text));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return voiceKeyFromHash(lang, hex);
}

/**
 * `?lang=&text=` as the route reads them: the language's primary subtag in
 * lower case ("fr-FR" → "fr"), the text trimmed. Empty strings when absent.
 */
export function ttsParams(params: URLSearchParams): { lang: string; text: string } {
  return {
    lang: params.get("lang")?.toLowerCase().split(/[-_]/)[0] ?? "",
    text: params.get("text")?.trim() ?? "",
  };
}
