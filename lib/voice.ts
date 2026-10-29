import crypto from "crypto";

/**
 * Pre-generated word audio (scripts/voice): open voices rendered offline,
 * once, into R2 under `voice/<lang>/<sha256>.mp3`. The key names neither the
 * engine nor the speaker, so re-rendering a language with a better voice
 * replaces its clips in place — browsers holding the old clip keep it until
 * their cache lapses, which is fine for a voice upgrade.
 */
export const VOICE_PREFIX = "voice/";

export function voiceKey(lang: string, text: string): string {
  const hash = crypto.createHash("sha256").update(`${lang}\n${text}`).digest("hex");
  return `${VOICE_PREFIX}${lang}/${hash}.mp3`;
}

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
