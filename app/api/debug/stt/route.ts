import { authUserOrNull } from "@/app/signInEmail";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import { isOwner } from "@/lib/owner";
import { checkRateLimit } from "@/lib/rateLimit";
import { STT_WINDOW_MS, handleStt } from "@/lib/stt-handler";
import { workersAiTranscribe } from "@/lib/workers-ai";

/** The debug chat mic's transcription: lib/stt-handler.ts has the rules. */
export const POST = async (req: Request) => {
  // The owner's dev server (lib/dev-bridge-user.ts) may ask as the owner; a
  // wrong bridge header is refused, never answered from the cookie.
  const bridged = await devBridgeUser(req);
  const user = bridged === undefined ? await authUserOrNull() : bridged;
  return handleStt(req, {
    user: user?.id ? { id: user.id } : null,
    owner: isOwner(user?.email),
    transcribe: workersAiTranscribe,
    limit: (key, max) => checkRateLimit(key, { windowMs: STT_WINDOW_MS, max }),
  });
};
