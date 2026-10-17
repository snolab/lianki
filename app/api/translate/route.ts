import { streamText } from "ai";
import {
  isWorkersAiConfigured,
  textModelHq,
  workersAiProvider,
  WORKERS_AI_NOT_CONFIGURED,
} from "@/lib/workers-ai";
import { NextRequest } from "next/server";
import { getRawPost } from "@/lib/blog";
import { BLOG_LOCALES, LOCALE_NAMES } from "@/lib/constants";
import { getPendingTranslation, persistTranslation, translationToken } from "@/lib/translation-pr";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";

export const maxDuration = 60;

// Max source content size to translate (prevent huge posts burning tokens)
const MAX_SOURCE_LENGTH = 50_000;

const RATE_LIMIT_WINDOW_MS = 10 * 60_000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 8;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const slug = searchParams.get("slug");
  const locale = searchParams.get("locale");

  if (!slug || !locale) {
    return new Response("Missing slug or locale", { status: 400 });
  }

  // Validate locale against allowlist
  if (!BLOG_LOCALES.includes(locale as (typeof BLOG_LOCALES)[number])) {
    return new Response("Unsupported locale", { status: 400 });
  }
  // Refuse requests to translate English to English
  if (locale === "en") {
    return new Response("Cannot translate to source locale", { status: 400 });
  }

  // Validate slug format (alphanumeric, hyphens only)
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return new Response("Invalid slug", { status: 400 });
  }

  const requesterEmail = await authEmailOrToken(request);
  if (!requesterEmail) {
    return new Response("Unauthorized", { status: 401 });
  }

  const rateLimit = checkRateLimit(`blog-translate:${requesterEmail}`, {
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_REQUESTS,
  });
  if (!rateLimit.allowed) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)),
      },
    });
  }

  if (!isWorkersAiConfigured()) {
    return new Response(WORKERS_AI_NOT_CONFIGURED, { status: 500 });
  }

  // Get the English source post
  const englishRaw = await getRawPost("en", slug);
  if (!englishRaw) {
    return new Response("Post not found", { status: 404 });
  }

  // Prevent translating unreasonably large posts
  if (englishRaw.length > MAX_SOURCE_LENGTH) {
    return new Response("Source post too large to translate", { status: 413 });
  }

  // The page renders committed translations itself and only calls this route
  // when the bundled corpus has none, so the one cache left to check is the
  // open translations PR: generated already, not yet deployed.
  const token = translationToken();
  const cacheKey = `${locale}/${slug}`;
  if (token) {
    try {
      const pending = await getPendingTranslation(token, locale, slug);
      if (pending) {
        return new Response(pending, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Cache-Status": "HIT-PR",
          },
        });
      }
    } catch (error) {
      logSanitizedError("translate.pending.get", error, { cacheKey });
    }
  }

  const targetLanguage = LOCALE_NAMES[locale] ?? locale;

  const result = streamText({
    model: workersAiProvider()(textModelHq()),
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

  // Pass the text through, and commit it to the translations PR only once the
  // stream has finished — a partial save is how truncated files reached blog/.
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

        // "length" means the model hit its token limit mid-post — don't commit that.
        if (token && fullText.trim() && (await result.finishReason) === "stop") {
          // Strip the markdown code fence the model sometimes wraps its output in
          const cleanedText = fullText.replace(/^```markdown\s*\n?/, "").replace(/\n?```\s*$/, "");
          try {
            await persistTranslation(token, locale, slug, cleanedText);
          } catch (error) {
            logSanitizedError("translate.persist", error, { cacheKey });
          }
        }
      } catch (error) {
        logSanitizedError("translate.stream", error, { cacheKey });
        throw error;
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
