import { NextRequest } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import { cfg } from "@/lib/config-store";
import { flagOn } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { metered } from "@/lib/payments/metered";
import { walletDb } from "@/lib/payments/wallet-db";
import { providerKey, synthesize } from "@/lib/cloud-voices";
import { cloudVoiceTts } from "@/lib/cloud-voices-handler";
import { GET as wordsSpeech } from "@/app/api/words/tts/route";

/**
 * One sentence of Li's read-aloud in a Google / Azure voice. What it serves,
 * who may, and what it costs: lib/cloud-voices-handler.ts.
 */
export const GET = async (req: NextRequest) => {
  // The whole-page guard forwards /api/words/tts to production. This existing
  // provider route stays on the development server; the shared handler keeps
  // the login, dev grant, configured-voice and rate-limit checks.
  if (process.env.LIANKI_DEV_WHOLE_PAGE === "1" && req.nextUrl.searchParams.has("localVoice"))
    return wordsSpeech(req);
  const user = await authUserOrNull();
  return cloudVoiceTts(req.nextUrl.searchParams, user?.email, {
    // Audience owner: the flag, and the dev grant (lib/permissions.ts).
    enabled: async (email) => isDev(email) && (await flagOn("voice.cloud-voices")),
    lexicon: () => cfg("voice.lexicon"),
    checkRateLimit,
    // Every account pays the same (docs/payments.md): no permission is consulted here.
    pay: (usd, run) =>
      metered(
        { d1: walletDb() },
        { userId: user!.id, email: user!.email },
        { what: "voice.cloud", holdUsd: usd },
        async () => ({ value: await run(), usd }),
      ),
    synthesize: async (v, text, lexicon) =>
      synthesize(v, text, {
        key: providerKey(v.kind),
        lexicon,
        region: await cfg("voice.azureRegion"),
        fetch: (url, init) => fetch(url, init),
        signal: req.signal,
      }),
    log: (where, err) => logSanitizedError(where, err, {}),
  });
};
