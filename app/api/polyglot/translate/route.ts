import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_TEXT_LENGTH = 2000;

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const rateLimit = checkRateLimit(`polyglot-translate:${email}`, {
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

    const { question, answer, targetLanguage, sourceLanguage } = await req.json();

    if (
      typeof question !== "string" ||
      typeof answer !== "string" ||
      question.length === 0 ||
      answer.length === 0 ||
      question.length > MAX_TEXT_LENGTH ||
      answer.length > MAX_TEXT_LENGTH
    ) {
      return NextResponse.json({ error: "Invalid question or answer" }, { status: 400 });
    }
    if (typeof sourceLanguage !== "string" || typeof targetLanguage !== "string") {
      return NextResponse.json({ error: "Invalid source/target language" }, { status: 400 });
    }

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
    logSanitizedError("polyglot.translate", error);
    return NextResponse.json({ error: "Failed to translate" }, { status: 500 });
  }
}
