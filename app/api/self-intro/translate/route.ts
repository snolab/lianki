import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "edge";

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

export async function POST(req: NextRequest) {
  try {
    const { answer, questionId, targetLanguage } = await req.json();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    // Create English sentence from template
    const template = QUESTION_TEMPLATES[questionId] || "{answer}";
    const englishSentence = template.replace("{answer}", answer);
    const targetLangName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

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
    return NextResponse.json({ error: "Failed to translate" }, { status: 500 });
  }
}
