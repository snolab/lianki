import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(req: NextRequest) {
  try {
    const { text, voice, speed } = await req.json();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice || "nova",
      input: text,
      speed: speed || 1.0,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="self-intro-${Date.now()}.mp3"`,
      },
    });
  } catch (error) {
    console.error("TTS error:", error);
    return NextResponse.json({ error: "Failed to generate audio" }, { status: 500 });
  }
}
