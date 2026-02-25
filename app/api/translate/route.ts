import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { NextRequest } from "next/server";
import { getRawPost } from "@/lib/blog";
import { LOCALE_NAMES } from "@/lib/constants";
import KeyvGitHub from "keyv-github";
import { Octokit } from "octokit";

export const maxDuration = 60;

// Initialize GitHub cache
function getGitHubCache() {
  const token = process.env.GITHUB_INTL_TOKEN;
  if (!token) return null;

  return new KeyvGitHub("https://github.com/snomiao/lianki/tree/main", {
    client: new Octokit({ auth: token }),
    prefix: "blog/",
    suffix: ".md",
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

  // Multi-layer cache: filesystem → GitHub → LLM translation
  const ghCache = getGitHubCache();
  const dir = locale === "zh" ? "cn" : locale;
  const cacheKey = `${dir}/${slug}`;

  // Layer 1: Check filesystem (fastest - already committed)
  const fsPost = await getRawPost(locale, slug);
  if (fsPost) {
    console.log(`[fs] ✓ Hit: blog/${cacheKey}.md`);
    return new Response(fsPost, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Cache-Status": "HIT-FS",
      },
    });
  }
  console.log(`[fs] ✗ Miss: blog/${cacheKey}.md`);

  // Layer 2: Check GitHub cache (medium - not yet committed to main)
  if (ghCache) {
    try {
      const ghData = await ghCache.get<string>(cacheKey);
      if (ghData) {
        const content = typeof ghData === "string" ? ghData : ghData.value;
        if (content) {
          console.log(`[gh-cache] ✓ Hit: ${cacheKey}`);
          return new Response(content, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Cache-Status": "HIT-GH",
            },
          });
        }
      }
      console.log(`[gh-cache] ✗ Miss: ${cacheKey}`);
    } catch (error) {
      console.error(`[gh-cache] Error:`, error);
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

        // Stream completed - save to GitHub (which commits to blog/)
        if (ghCache) {
          try {
            // Clean the text before saving (strip markdown code fence if LLM added it)
            const cleanedText = fullText
              .replace(/^```markdown\s*\n?/, "") // Remove opening fence
              .replace(/\n?```\s*$/, ""); // Remove closing fence

            await ghCache.set(cacheKey, cleanedText);
            console.log(`[gh-cache] ✓ Saved: blog/${cacheKey}.md`);
          } catch (error) {
            console.error(`[gh-cache] ✗ Error saving:`, error);
          }
        }
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
