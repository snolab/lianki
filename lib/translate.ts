import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const LOCALE_NAMES: Record<string, string> = {
  cn: "Simplified Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
};

export async function translatePost(rawMarkdown: string, targetLocale: string): Promise<string> {
  const targetLanguage = LOCALE_NAMES[targetLocale] ?? targetLocale;

  // .stream() starts immediately and .finalText() resolves when done
  return client.messages
    .stream({
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
    })
    .finalText();
}
