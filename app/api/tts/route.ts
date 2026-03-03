import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Readable } from "stream";
import crypto from "crypto";
import { getTTSVoiceCacheBucket } from "@/app/[locale]/read/getReadMaterialsCollection";
import { auth } from "@/auth";
import { headers } from "next/headers";

const MAX_TEXT_LENGTH = 4096; // OpenAI's limit

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

  console.log("TTS request:", { text: text.substring(0, 50), voice, model });

  // Generate cache key based on text, voice, and model
  const cacheKey = crypto.createHash("sha256").update(`${model}:${voice}:${text}`).digest("hex");

  const bucket = getTTSVoiceCacheBucket();

  // Try to find cached audio
  try {
    const files = await bucket.find({ filename: cacheKey }).limit(1).toArray();
    if (files.length > 0) {
      console.log("TTS cache hit:", cacheKey);
      const downloadStream = bucket.openDownloadStreamByName(cacheKey);
      const chunks: Buffer[] = [];
      for await (const chunk of downloadStream) {
        chunks.push(chunk);
      }
      const audioBuffer = Buffer.concat(chunks);
      return new Response(audioBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
    // No cached file found, proceed to generate
    console.log("TTS cache miss:", cacheKey);
  } catch (err) {
    console.error("TTS cache lookup error:", err);
    // Continue to generate even if cache lookup fails
  }

  // Generate new audio with OpenAI
  console.log("Generating TTS with OpenAI...");
  const openai = new OpenAI();

  let response;
  try {
    response = await openai.audio.speech.create({
      model: model as Model,
      voice: voice as Voice,
      input: text,
    });
  } catch (err) {
    console.error("OpenAI TTS error:", err);
    return NextResponse.json({ error: "Failed to generate speech" }, { status: 500 });
  }

  // Convert response to buffer
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Cache the audio in GridFS
  try {
    const uploadStream = bucket.openUploadStream(cacheKey, {
      metadata: {
        model,
        voice,
        textHash: cacheKey,
        textLength: text.length,
        createdAt: new Date(),
      },
    });

    // Convert buffer to readable stream for GridFS
    const readable = Readable.from(audioBuffer);
    readable.pipe(uploadStream);

    await new Promise((resolve, reject) => {
      uploadStream.on("finish", resolve);
      uploadStream.on("error", reject);
    });

    console.log("TTS cached:", cacheKey);
  } catch (err) {
    console.error("Failed to cache TTS audio:", err);
    // Continue even if caching fails
  }

  return new Response(audioBuffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
};
