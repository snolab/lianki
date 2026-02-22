import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { NextRequest } from "next/server";
import { getRawPost } from "@/lib/blog";
import { commitFile } from "@/lib/github-commit";
import Keyv from "keyv";
import KeyvGitHub from "keyv-github";
import { Octokit } from "octokit";

export const maxDuration = 60;

const LOCALE_NAMES: Record<string, string> = {
  zh: "Simplified Chinese",
  ja: "Japanese",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  ar: "Arabic",
  bn: "Bengali",
  pt: "Portuguese",
  ru: "Russian",
  ur: "Urdu",
  id: "Indonesian",
  de: "German",
  sw: "Swahili",
  mr: "Marathi",
  ko: "Korean",
};

// Initialize cache with GitHub adapter
function getCache() {
  const token = process.env.GITHUB_INTL_TOKEN;
  if (!token) return null;

  const store = new KeyvGitHub("https://github.com/snomiao/lianki/tree/main", {
    client: new Octokit({ auth: token }),
    prefix: ".cache/translations/",
    suffix: ".md",
  });

  return new Keyv({ store });
}

// Stream cached text with chunks to simulate streaming
async function streamCachedText(cachedText: string): Promise<ReadableStream> {
  const encoder = new TextEncoder();
  const chunkSize = 50; // chars per chunk

  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < cachedText.length; i += chunkSize) {
        const chunk = cachedText.slice(i, i + chunkSize);
        controller.enqueue(encoder.encode(chunk));
        // Small delay to simulate streaming
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.close();
    },
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const slug = searchParams.get("slug");
  const locale = searchParams.get("locale");

  if (!slug || !locale) {
    return new Response("Missing slug or locale", { status: 400 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return new Response("OPENAI_API_KEY not configured", { status: 500 });
  }

  // Get the English source post
  const englishRaw = await getRawPost("en", slug);
  if (!englishRaw) {
    return new Response("Post not found", { status: 404 });
  }

  // Check cache first
  const cache = getCache();
  const cacheKey = `translate:${locale}:${slug}`;

  if (cache) {
    try {
      const cached = await cache.get<string>(cacheKey);
      if (cached) {
        console.log(`[cache] ✓ Hit: ${cacheKey}`);
        return new Response(await streamCachedText(cached), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Cache-Status": "HIT",
          },
        });
      }
      console.log(`[cache] ✗ Miss: ${cacheKey}`);
    } catch (error) {
      console.error(`[cache] Error reading cache:`, error);
      // Continue to translation if cache fails
    }
  }

  const targetLanguage = LOCALE_NAMES[locale] ?? locale;

  const result = streamText({
    model: openai("gpt-4o"),
    system: `You are a professional technical translator. Translate markdown blog posts accurately while:
- Preserving ALL markdown formatting (headers, bold, italic, lists, tables, code blocks)
- Preserving ALL code snippets exactly as-is (do not translate code inside backticks or code fences)
- Translating frontmatter fields: title, summary, and tags (translate tag text but keep array structure)
- Keeping frontmatter keys (title, date, tags, summary) in English
- Keeping the date field unchanged
- Preserving all URLs and links unchanged
- Outputting ONLY the translated markdown, no commentary`,
    prompt: `Translate the following markdown blog post to ${targetLanguage}:\n\n${englishRaw}`,
  });

  // Create a custom stream that collects the full text and commits after streaming
  const { textStream } = result;
  const encoder = new TextEncoder();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of textStream) {
          fullText += chunk;
          controller.enqueue(encoder.encode(chunk));
        }

        // Stream completed - cache, then commit to GitHub
        if (cache) {
          try {
            await cache.set(cacheKey, fullText);
            console.log(`[cache] ✓ Saved: ${cacheKey}`);
          } catch (error) {
            console.error(`[cache] ✗ Error saving:`, error);
          }
        }

        const dir = locale === "zh" ? "cn" : locale;
        const filePath = `blog/${dir}/${slug}.md`;

        console.log(`[auto-commit] Starting commit: ${filePath}`);
        await commitFile(filePath, fullText, `auto: translate ${slug} to ${locale} [skip ci]`);
        console.log(`[auto-commit] ✓ Success: ${filePath}`);
      } catch (error) {
        console.error(`[auto-commit] ✗ Error:`, error);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Cache-Status": "MISS",
    },
  });
}
