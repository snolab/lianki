import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { authEmail } from "@/app/signInEmail";

const QUESTION_TEMPLATES: Record<string, string> = {
  name: "My name is {answer}.",
  from: "I am from {answer}.",
  age: "I am {answer} years old.",
  occupation: "I am a {answer}.",
  hobby: "I like {answer}.",
  languages: "I speak {answer}.",
};

const LANGUAGE_NAMES: Record<string, string> = {
  "en-US": "English",
  "zh-CN": "Chinese (Simplified)",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "es-ES": "Spanish",
  "fr-FR": "French",
  "de-DE": "German",
  "it-IT": "Italian",
  "pt-BR": "Portuguese",
  "ru-RU": "Russian",
};

const MAX_ANSWER_LENGTH = 200;

export async function POST(req: NextRequest) {
  try {
    await authEmail(); // Require authentication

    const { answer, questionId, targetLanguage } = await req.json();

    // Validate inputs
    if (typeof answer !== "string" || answer.length === 0 || answer.length > MAX_ANSWER_LENGTH) {
      return NextResponse.json(
        { error: `Answer must be 1–${MAX_ANSWER_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (!Object.keys(QUESTION_TEMPLATES).includes(questionId)) {
      return NextResponse.json({ error: "Invalid questionId" }, { status: 400 });
    }
    if (!Object.keys(LANGUAGE_NAMES).includes(targetLanguage)) {
      return NextResponse.json({ error: "Unsupported targetLanguage" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    // Create English sentence from template
    const template = QUESTION_TEMPLATES[questionId];
    const englishSentence = template.replace("{answer}", answer);
    const targetLangName = LANGUAGE_NAMES[targetLanguage];

    // Use OpenAI to translate
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the given English sentence to ${targetLangName}.
Only return the translated sentence, nothing else.
Make it natural and appropriate for self-introduction.
If the target language is the same as the input, just return it as is.`,
        },
        {
          role: "user",
          content: englishSentence,
        },
      ],
      temperature: 0.3,
    });

    const translatedText = completion.choices[0]?.message?.content?.trim() || englishSentence;

    return NextResponse.json({ translatedText });
  } catch (error) {
    console.error("Translation error:", error);
    if ((error as Error).message?.includes("email")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to translate" }, { status: 500 });
  }
}
