import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { boxChatCaller } from "@/lib/box-oauth/chat-ticket";
import { BOX_IDENTITY_HEADER } from "@/lib/box-oauth/identity";
import type { BoxDb } from "@/lib/box-oauth/store";
import { getD1 } from "@/lib/d1";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import { isOwner } from "@/lib/owner";
import { checkRateLimit } from "@/lib/rateLimit";
import { STT_WINDOW_MS, handleStt } from "@/lib/stt-handler";
import { workersAiTranscribe } from "@/lib/workers-ai";

/** The debug chat mic's transcription: lib/stt-handler.ts has the rules. */
export const POST = async (req: Request) => {
  // A box token (docs/box-oauth.md, "Chat on the owner's box"): only a live
  // box:chat binding of a site owner, checked here as well as at the gate.
  if (req.headers.has(BOX_IDENTITY_HEADER)) {
    const ok = await Promise.resolve()
      .then(() => boxChatCaller(req.headers, process.env.AUTH_SECRET, getD1() as unknown as BoxDb))
      .catch(() => null);
    if (!ok) return NextResponse.json({ error: "Out of scope" }, { status: 403 });
  }
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
