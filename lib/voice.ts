import crypto from "crypto";
import { voiceHashInput, voiceKeyFromHash } from "@/lib/voice-clip";

/**
 * Pre-generated word audio (scripts/voice): open voices rendered offline,
 * once, into R2 under `voice/<lang>/<sha256>.mp3` — see lib/voice-clip.ts,
 * which also holds the credits and the WebCrypto key for the edge Worker.
 */
export { VOICE_CREDITS, VOICE_PREFIX } from "@/lib/voice-clip";

export function voiceKey(lang: string, text: string): string {
  const hash = crypto.createHash("sha256").update(voiceHashInput(lang, text)).digest("hex");
  return voiceKeyFromHash(lang, hash);
}
