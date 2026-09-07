import { NextRequest, NextResponse } from "next/server";
import {
  isWorkersAiConfigured,
  workersAiSpeech,
  WORKERS_AI_NOT_CONFIGURED,
} from "@/lib/workers-ai";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_TEXT_LENGTH = 1000;

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const rateLimit = checkRateLimit(`polyglot-tts:${email}`, {
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX_REQUESTS,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please retry later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)),
          },
        },
      );
    }

    const { text } = await req.json();
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Text must be 1-${MAX_TEXT_LENGTH} characters` },
        { status: 400 },
      );
    }

    if (!isWorkersAiConfigured()) {
      return NextResponse.json({ error: WORKERS_AI_NOT_CONFIGURED }, { status: 500 });
    }

    // MeloTTS has no voice or speed control, so the previous "nova" at 1.0x has
    // no equivalent — it picks the voice from the language.
    const buffer = await workersAiSpeech({ text });

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="polyglot-${Date.now()}.mp3"`,
      },
    });
  } catch (error) {
    logSanitizedError("polyglot.tts", error);
    return NextResponse.json({ error: "Failed to generate audio" }, { status: 500 });
  }
}
