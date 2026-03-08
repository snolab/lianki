import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { NextRequest } from "next/server";
import { getRawPost } from "@/lib/blog";
import { BLOG_LOCALES, LOCALE_NAMES } from "@/lib/constants";
import KeyvGitHub from "keyv-github";
import { Octokit } from "octokit";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";

export const maxDuration = 60;

// Max source content size to translate (prevent huge posts burning tokens)
const MAX_SOURCE_LENGTH = 50_000;

const LOCK_TIMEOUT_MS = 120_000; // 2 minutes - if lock is older, assume stale
const PARTIAL_SAVE_INTERVAL = 1000; // Save every 1000 characters
const RATE_LIMIT_WINDOW_MS = 10 * 60_000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 8;

interface CacheMetadata {
  status: "in-progress" | "complete";
  timestamp: number;
  lastSaveLength?: number;
}

// Initialize GitHub cache
function getGitHubCache() {
  const token = process.env.GITHUB_INTL_TOKEN;
  if (!token) return null;

  return new KeyvGitHub("https://github.com/snomiao/lianki/tree/main", {
    client: new Octokit({ auth: token }),
    prefix: "blog/",
    suffix: ".md",
    msg: (key: string) => `docs: update ${key} [skip ci]`,
  });
}

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

  if (!process.env.OPENAI_API_KEY) {
    return new Response("OPENAI_API_KEY not configured", { status: 500 });
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

  // Multi-layer cache: filesystem → GitHub → LLM translation
  const ghCache = getGitHubCache();
  const cacheKey = `${locale}/${slug}`;
  const lockKey = `${cacheKey}.lock`;

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
      logSanitizedError("translate.gh-cache.get", error, { cacheKey });
    }

    // Check if translation is already in progress
    try {
      const lockData = await ghCache.get<CacheMetadata>(lockKey);
      if (lockData) {
        const lock = typeof lockData === "object" ? lockData : JSON.parse(lockData as string);
        const age = Date.now() - lock.timestamp;

        if (age < LOCK_TIMEOUT_MS && lock.status === "in-progress") {
          console.log(`[lock] Translation already in progress (${Math.round(age / 1000)}s old)`);
          return new Response("Translation in progress, please retry in a few seconds", {
            status: 503,
            headers: {
              "Retry-After": "5",
              "X-Translation-Status": "in-progress",
            },
          });
        } else if (age >= LOCK_TIMEOUT_MS) {
          console.log(`[lock] Stale lock detected (${Math.round(age / 1000)}s old), clearing`);
          await ghCache.delete(lockKey);
        }
      }
    } catch (error) {
      logSanitizedError("translate.lock.check", error, { lockKey });
    }

    // Set lock before starting translation
    try {
      const metadata: CacheMetadata = {
        status: "in-progress",
        timestamp: Date.now(),
      };
      await ghCache.set(lockKey, JSON.stringify(metadata));
      console.log(`[lock] ✓ Acquired lock for ${cacheKey}`);
    } catch (error) {
      logSanitizedError("translate.lock.set", error, { lockKey });
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

  // Create a custom stream that collects the full text and saves progressively
  const { textStream } = result;
  const encoder = new TextEncoder();
  let fullText = "";
  let lastSaveLength = 0;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of textStream) {
          fullText += chunk;
          controller.enqueue(encoder.encode(chunk));

          // Save partial progress periodically to handle interrupted streams
          if (ghCache && fullText.length - lastSaveLength >= PARTIAL_SAVE_INTERVAL) {
            try {
              const cleanedText = fullText
                .replace(/^```markdown\s*\n?/, "")
                .replace(/\n?```\s*$/, "");

              await ghCache.set(cacheKey, cleanedText);
              lastSaveLength = fullText.length;
              console.log(`[gh-cache] ✓ Saved partial (${fullText.length} chars): ${cacheKey}`);
            } catch (error) {
              logSanitizedError("translate.gh-cache.partial-save", error, { cacheKey });
            }
          }
        }

        // Stream completed - save final version and mark complete
        if (ghCache) {
          try {
            // Clean the text before saving (strip markdown code fence if LLM added it)
            const cleanedText = fullText
              .replace(/^```markdown\s*\n?/, "") // Remove opening fence
              .replace(/\n?```\s*$/, ""); // Remove closing fence

            await ghCache.set(cacheKey, cleanedText);
            console.log(
              `[gh-cache] ✓ Saved complete (${fullText.length} chars): blog/${cacheKey}.md`,
            );

            // Remove lock to indicate completion
            await ghCache.delete(lockKey);
            console.log(`[lock] ✓ Released lock for ${cacheKey}`);
          } catch (error) {
            logSanitizedError("translate.gh-cache.final-save", error, { cacheKey });
          }
        }
      } catch (error) {
        logSanitizedError("translate.stream", error, { cacheKey });

        // Clean up lock on error
        if (ghCache) {
          try {
            await ghCache.delete(lockKey);
            console.log(`[lock] ✓ Released lock after error`);
          } catch (lockError) {
            logSanitizedError("translate.lock.release-after-error", lockError, { lockKey });
          }
        }
        throw error;
      } finally {
        controller.close();
      }
    },

    // Handle client disconnection
    cancel() {
      console.log(`[stream] Client disconnected, saving partial content`);
      if (ghCache && fullText.length > 0) {
        const cleanedText = fullText.replace(/^```markdown\s*\n?/, "").replace(/\n?```\s*$/, "");

        ghCache
          .set(cacheKey, cleanedText)
          .then(() => {
            console.log(`[gh-cache] ✓ Saved partial after disconnect (${fullText.length} chars)`);
            return ghCache.delete(lockKey);
          })
          .then(() => console.log(`[lock] ✓ Released lock after disconnect`))
          .catch((error) => logSanitizedError("translate.cancel", error, { cacheKey, lockKey }));
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
