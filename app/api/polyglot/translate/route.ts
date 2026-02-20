import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { authEmail } from "@/app/signInEmail";

export async function POST(req: NextRequest) {
  try {
    await authEmail(); // Require authentication

    const { question, answer, targetLanguage, sourceLanguage } = await req.json();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    // Translate both question and answer
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional translator. You will receive a question and an answer in ${sourceLanguage}.
Translate both to ${targetLanguage}.
Return a JSON object with two fields: "question" and "answer".
Make the translations natural and conversational.`,
        },
        {
          role: "user",
          content: JSON.stringify({ question, answer }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || "{}");

    return NextResponse.json({
      translatedQuestion: result.question || question,
      translatedAnswer: result.answer || answer,
    });
  } catch (error) {
    console.error("Translation error:", error);
    if ((error as Error).message?.includes("email")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to translate" }, { status: 500 });
  }
}
