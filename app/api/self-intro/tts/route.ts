import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";

const MAX_TEXT_LENGTH = 500;
const ALLOWED_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
type Voice = (typeof ALLOWED_VOICES)[number];
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 40;

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const rateLimit = checkRateLimit(`self-intro-tts:${email}`, {
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

    const { text, voice = "nova", speed = 1.0 } = await req.json();

    // Validate inputs
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Text must be 1–${MAX_TEXT_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (!ALLOWED_VOICES.includes(voice)) {
      return NextResponse.json(
        { error: `Invalid voice. Allowed: ${ALLOWED_VOICES.join(", ")}` },
        { status: 400 },
      );
    }
    if (typeof speed !== "number" || speed < 0.25 || speed > 4.0) {
      return NextResponse.json({ error: "Speed must be between 0.25 and 4.0" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice as Voice,
      input: text,
      speed,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="self-intro-${Date.now()}.mp3"`,
      },
    });
  } catch (error) {
    logSanitizedError("self-intro.tts", error);
    return NextResponse.json({ error: "Failed to generate audio" }, { status: 500 });
  }
}
