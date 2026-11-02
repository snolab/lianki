import { NextRequest } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import { isWorkersAiConfigured, speechModel, workersAiSpeech } from "@/lib/workers-ai";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import { getCachedTTS, getVoiceClip, putCachedTTS } from "@/lib/ttsCache";
import { wordsTts } from "@/lib/words-tts";

/**
 * Word audio for /words, and the chat's read-aloud (`store=0`). What it
 * serves, what it keeps and what it costs: lib/words-tts.ts.
 */
export const GET = async (req: NextRequest) => {
  // The owner's dev server (lib/dev-bridge-user.ts) may ask as the owner; a
  // wrong bridge header is refused, never answered from the cookie.
  const bridged = await devBridgeUser(req);
  const user = bridged === undefined ? await authUserOrNull() : bridged;
  return wordsTts(
    req.nextUrl.searchParams,
    user?.email,
    {
      getVoiceClip,
      getCachedTTS,
      putCachedTTS,
      checkRateLimit,
      isConfigured: isWorkersAiConfigured,
      speechModel,
      speech: workersAiSpeech,
      log: (where, err) => logSanitizedError(where, err, {}),
    },
    req.signal,
  );
};
