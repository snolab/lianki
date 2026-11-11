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
import { freeCall } from "@/lib/payments/paid-calls";
import { speechUsd } from "@/lib/payments/prices";

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
      // Free by the owner's decision (2026-11-09): what a miss costs us is
      // logged and booked to this account (docs/payments.md, "Cost ledger").
      pay: <T>(text: string, aura: boolean, run: () => Promise<T>) =>
        freeCall("words.tts", speechUsd(text.length, aura), run, {
          userId: user?.id,
          db: dbBackend() === "d1" ? getD1() : null,
          units: text.length,
        }),
      isPrivate: async (email, text, lang) =>
        dbBackend() === "d1" && isPrivateSpeech(getD1(), email, text, lang),
    },
    req.signal,
  );
};
