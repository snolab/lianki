import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
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

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: text,
      speed: 1.0,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

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
