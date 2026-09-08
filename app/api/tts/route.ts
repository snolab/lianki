import { NextRequest, NextResponse } from "next/server";
import {
  isWorkersAiConfigured,
  sniffAudioType,
  speechModel,
  workersAiSpeech,
  WORKERS_AI_NOT_CONFIGURED,
} from "@/lib/workers-ai";
import crypto from "crypto";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import { getCachedTTS, putCachedTTS } from "@/lib/ttsCache";

const MAX_TEXT_LENGTH = 4096;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

const ALLOWED_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
type Voice = (typeof ALLOWED_VOICES)[number];

const ALLOWED_MODELS = ["tts-1", "tts-1-hd"] as const;
type Model = (typeof ALLOWED_MODELS)[number];

export const POST = async (req: NextRequest) => {
  // Require authentication
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const requester = session.user.email ?? session.user.id;

  const rateLimit = checkRateLimit(`tts:${requester}`, {
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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { text, voice = "shimmer", model = "tts-1" } = body || {};

  if (typeof text !== "string" || text.length === 0) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // Validate text length
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` },
      { status: 400 },
    );
  }

  // Validate voice against allowlist
  if (!ALLOWED_VOICES.includes(voice)) {
    return NextResponse.json(
      { error: `Invalid voice. Allowed: ${ALLOWED_VOICES.join(", ")}` },
      { status: 400 },
    );
  }

  // Validate model against allowlist
  if (!ALLOWED_MODELS.includes(model)) {
    return NextResponse.json(
      { error: `Invalid model. Allowed: ${ALLOWED_MODELS.join(", ")}` },
      { status: 400 },
    );
  }

  console.log("TTS request:", { textLength: text.length, voice, model });

  // Generate cache key based on text, voice, and model
  // The provider is part of the key on purpose. Without it, MeloTTS audio would
  // be stored under a key that names an OpenAI voice, and every previously
  // cached tts-1 clip would keep being served as if it were current output —
  // the same text sounding different depending on cache age, with nothing in
  // the key to explain why.
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${speechModel()}:${model}:${voice}:${text}`)
    .digest("hex");

  // Try to find cached audio
  try {
    const cached = await getCachedTTS(cacheKey);
    if (cached) {
      console.log("TTS cache hit:", cacheKey);
      const bytes = Buffer.from(cached);
      // Sniff rather than assume: the cache may hold MP3 from the OpenAI era
      // and WAV from MeloTTS, and serving one labelled as the other is how a
      // player ends up silently refusing a file that is actually fine.
      return new Response(bytes, {
        headers: {
          "Content-Type": sniffAudioType(bytes),
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
    console.log("TTS cache miss:", cacheKey);
  } catch (err) {
    logSanitizedError("tts.cache.lookup", err, { requester });
    // Continue to generate even if cache lookup fails
  }

  // Generate new audio with Workers AI
  console.log("Generating TTS with Workers AI...");
  if (!isWorkersAiConfigured()) {
    return NextResponse.json({ error: WORKERS_AI_NOT_CONFIGURED }, { status: 500 });
  }

  let audioBuffer: Buffer<ArrayBuffer>;
  let audioType: string;
  try {
    // `voice` and `model` stay validated and stay in the cache key, but MeloTTS
    // has neither — one voice per language, no tts-1/tts-1-hd tiers. Kept in
    // the request contract so existing clients do not break; see
    // docs/workers-ai.md for what that costs.
    ({ audio: audioBuffer, contentType: audioType } = await workersAiSpeech({ text }));
  } catch (err) {
    logSanitizedError("tts.workersai.generate", err, { requester });
    return NextResponse.json({ error: "Failed to generate speech" }, { status: 500 });
  }

  // Cache the audio (R2 or GridFS depending on DB_BACKEND)
  try {
    await putCachedTTS(cacheKey, audioBuffer, {
      model,
      voice,
      textHash: cacheKey,
      textLength: text.length,
      createdAt: new Date().toISOString(),
    });
    console.log("TTS cached:", cacheKey);
  } catch (err) {
    logSanitizedError("tts.cache.save", err, { requester, cacheKey });
    // Continue even if caching fails
  }

  return new Response(audioBuffer, {
    headers: {
      "Content-Type": audioType,
      "Cache-Control": "private, max-age=86400",
    },
  });
};
