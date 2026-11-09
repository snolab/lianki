import { NextRequest } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import { isWorkersAiConfigured, speechModel, workersAiSpeech } from "@/lib/workers-ai";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import { getCachedTTS, getVoiceClip, putCachedTTS } from "@/lib/ttsCache";
import { isPrivateSpeech } from "@/lib/vibe/private-speech";
import { wordsTts } from "@/lib/words-tts";
import { paidSpeech } from "@/lib/payments/paid-calls";
import { walletDb } from "@/lib/payments/wallet-db";

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
      // A cache miss is paid from the user's credits (docs/payments.md, "What costs credits").
      ...(user?.id
        ? {
            pay: <T>(text: string, aura: boolean, run: () => Promise<T>) =>
              paidSpeech(
                { userId: user.id, email: user.email, db: walletDb() },
                "words.tts",
                text,
                run,
                aura,
              ),
          }
        : {}),
      isPrivate: async (email, text, lang) =>
        dbBackend() === "d1" && isPrivateSpeech(getD1(), email, text, lang),
    },
    req.signal,
  );
};
