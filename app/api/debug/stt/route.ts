import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { checkRateLimit } from "@/lib/rateLimit";
import { STT_WINDOW_MS, handleStt } from "@/lib/stt-handler";
import { workersAiTranscribe } from "@/lib/workers-ai";

/** The debug chat mic's transcription: lib/stt-handler.ts has the rules. */
export const POST = async (req: Request) => {
  const user = await authUserOrNull();
  return handleStt(req, {
    user: user?.id ? { id: user.id } : null,
    owner: isOwner(user?.email),
    transcribe: workersAiTranscribe,
    limit: (key, max) => checkRateLimit(key, { windowMs: STT_WINDOW_MS, max }),
  });
};
