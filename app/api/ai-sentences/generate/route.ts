import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 40;

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const rateLimit = checkRateLimit(`ai-sentences:${email}`, {
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX_REQUESTS,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please retry later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) },
        },
      );
    }

    const { word, language, topic, historySentences } = await req.json();

    if (typeof word !== "string" || word.length === 0 || word.length > 100) {
      return NextResponse.json({ error: "Invalid word" }, { status: 400 });
    }
    if (typeof language !== "string" || language.length === 0) {
      return NextResponse.json({ error: "Invalid language" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const historyContext =
      Array.isArray(historySentences) && historySentences.length > 0
        ? `\nAvoid reusing these previous sentences:\n${historySentences.slice(-10).join("\n")}`
        : "";

    const topicContext = topic ? `The sentence should relate to the topic: "${topic}".` : "";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a language learning assistant. Generate a natural example sentence using the given word in ${language}.
Return a JSON object with these fields:
- "word": the target word
- "sentence": a natural sentence using the word (5-500 characters)
- "reading": phonetic transcription appropriate for the language (hiragana for Japanese, pinyin for Chinese, romanization for Korean, IPA for others)
- "explanation": a brief explanation of the sentence relating to the word and context (5-200 characters, in English)

${topicContext}${historyContext}`,
        },
        {
          role: "user",
          content: `Generate a sentence for the word: "${word}"`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || "{}");

    return NextResponse.json({
      word: result.word || word,
      sentence: result.sentence || "",
      reading: result.reading || "",
      explanation: result.explanation || "",
    });
  } catch (error) {
    logSanitizedError("ai-sentences.generate", error);
    return NextResponse.json({ error: "Failed to generate sentence" }, { status: 500 });
  }
}
