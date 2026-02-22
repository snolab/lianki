import OpenAI from "openai";
import { LOCALE_NAMES } from "@/lib/constants";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function translatePost(rawMarkdown: string, targetLocale: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is not configured");
  }

  const targetLanguage = LOCALE_NAMES[targetLocale] ?? targetLocale;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8192,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You are a professional technical translator. Translate markdown blog posts accurately while:
- Preserving ALL markdown formatting (headers, bold, italic, lists, tables, code blocks)
- Preserving ALL code snippets exactly as-is (do not translate code inside backticks or code fences)
- Translating frontmatter fields: title, summary, and tags (translate tag text but keep array structure)
- Keeping frontmatter keys (title, date, tags, summary) in English
- Keeping the date field unchanged
- Preserving all URLs and links unchanged
- Outputting ONLY the translated markdown, no commentary`,
      },
      {
        role: "user",
        content: `Translate the following markdown blog post to ${targetLanguage}:\n\n${rawMarkdown}`,
      },
    ],
  });

  const translated = response.choices[0]?.message?.content;
  if (!translated) {
    throw new Error("OpenAI returned empty translation");
  }

  return translated;
}
