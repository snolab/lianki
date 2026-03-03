import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";
import { Readable } from "stream";
import crypto from "crypto";
import DIE from "phpdie";
import { getTTSVoiceCacheBucket } from "@/app/[locale]/read/getReadMaterialsCollection";

const MAX_TEXT_LENGTH = 4096; // OpenAI's limit

export const GET = async (req: NextRequest) => {
  const text = req.nextUrl.searchParams.get("text") || DIE("text is required");
  const voice = (req.nextUrl.searchParams.get("voice") as any) || "shimmer";
  const model = req.nextUrl.searchParams.get("model") || "tts-1";

  // Validate text length
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` },
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
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }
  } catch (err) {
    console.log("TTS cache miss:", cacheKey);
  }

  // Generate new audio with OpenAI
  console.log("Generating TTS with OpenAI...");
  const openai = new OpenAI();

  let response;
  try {
    response = await openai.audio.speech.create({
      model: model as "tts-1" | "tts-1-hd",
      voice: voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
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
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
