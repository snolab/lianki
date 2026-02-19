import Anthropic from "@anthropic-ai/sdk";

const LOCALE_NAMES: Record<string, string> = {
  cn: "Simplified Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
};

export async function translatePost(rawMarkdown: string, targetLocale: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const targetLanguage = LOCALE_NAMES[targetLocale] ?? targetLocale;

  const message = await client.messages.create({
    model: "claude-opus-4-5-20251101",
    max_tokens: 8192,
    system: `You are a professional technical translator. Translate markdown blog posts accurately while:
- Preserving ALL markdown formatting (headers, bold, italic, lists, tables, code blocks)
- Preserving ALL code snippets exactly as-is (do not translate code inside backticks or code fences)
- Translating frontmatter fields: title, summary, and tags (translate tag text but keep array structure)
- Keeping frontmatter keys (title, date, tags, summary) in English
- Keeping the date field unchanged
- Preserving all URLs and links unchanged
- Outputting ONLY the translated markdown, no commentary`,
    messages: [
      {
        role: "user",
        content: `Translate the following markdown blog post to ${targetLanguage}:\n\n${rawMarkdown}`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}
