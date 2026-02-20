import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { authEmail } from "@/app/signInEmail";

export async function POST(req: NextRequest) {
  try {
    await authEmail(); // Require authentication

    const { text } = await req.json();

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
    console.error("TTS error:", error);
    if ((error as Error).message?.includes("email")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to generate audio" }, { status: 500 });
  }
}
