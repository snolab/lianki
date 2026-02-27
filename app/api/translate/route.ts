import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { NextRequest } from "next/server";
import { getRawPost } from "@/lib/blog";
import { LOCALE_NAMES } from "@/lib/constants";
import KeyvGitHub from "keyv-github";
import { Octokit } from "octokit";

export const maxDuration = 300; // 5 minutes for long translations

const LOCK_TIMEOUT_MS = 120_000; // 2 minutes - if lock is older, assume stale
const PARTIAL_SAVE_INTERVAL = 1000; // Save every 1000 characters
const PARTIAL_MAX_AGE_MS = 300_000; // 5 minutes - reject old partials

interface CacheMetadata {
  status: "in-progress" | "complete";
  timestamp: number;
  lastSaveLength?: number;
}

interface CachedTranslation {
  content: string;
  status: "complete" | "partial";
  timestamp: number;
  sourceLength: number;
  translatedLength: number;
}

// Initialize GitHub cache
function getGitHubCache() {
  const token = process.env.GITHUB_INTL_TOKEN;
  if (!token) return null;

  return new KeyvGitHub("https://github.com/snomiao/lianki/tree/main", {
    client: new Octokit({ auth: token }),
    prefix: "blog/",
    suffix: ".md",
    msg: (key: string) => `docs: update blog/${key}.md [skip ci]`,
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

  // Layer 2: Check GitHub cache with validation (medium - not yet committed to main)
  if (ghCache) {
    try {
      const ghData = await ghCache.get<CachedTranslation | string>(cacheKey);
      if (ghData) {
        // Try to parse as structured CachedTranslation first
        let cached: CachedTranslation | null = null;
        if (typeof ghData === "string") {
          try {
            cached = JSON.parse(ghData);
          } catch {
            // Legacy format: plain string, assume complete
            console.log(`[gh-cache] ✓ Hit (legacy format): ${cacheKey}`);
            return new Response(ghData, {
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "X-Cache-Status": "HIT-GH",
              },
            });
          }
        } else {
          cached = ghData as CachedTranslation;
        }

        if (cached && cached.content) {
          const age = Date.now() - cached.timestamp;

          // Reject old partial translations
          if (cached.status === "partial") {
            if (age > PARTIAL_MAX_AGE_MS) {
              console.log(`[gh-cache] ✗ Partial too old (${Math.round(age / 1000)}s), retranslating`);
              await ghCache.delete(cacheKey);
            } else {
              console.log(`[gh-cache] ⏳ Partial in progress (${cached.translatedLength}/${cached.sourceLength} chars)`);
              return new Response("Translation in progress (partial cached)", {
                status: 503,
                headers: {
                  "Retry-After": "10",
                  "X-Translation-Status": "partial",
                },
              });
            }
          } else if (cached.status === "complete") {
            // Validate complete translation isn't suspiciously short
            const minExpected = englishRaw.length * 0.5; // At least 50% of source
            if (cached.translatedLength < minExpected) {
              console.warn(
                `[gh-cache] ✗ Suspiciously short (${cached.translatedLength}/${englishRaw.length}), retranslating`
              );
              await ghCache.delete(cacheKey);
            } else {
              console.log(
                `[gh-cache] ✓ Hit (complete): ${cacheKey} (${cached.translatedLength} chars)`
              );
              return new Response(cached.content, {
                headers: {
                  "Content-Type": "text/plain; charset=utf-8",
                  "X-Cache-Status": "HIT-GH",
                },
              });
            }
          }
        }
      }
      console.log(`[gh-cache] ✗ Miss: ${cacheKey}`);
    } catch (error) {
      console.error(`[gh-cache] Error:`, error);
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
      console.error(`[lock] Error checking lock:`, error);
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
      console.error(`[lock] ✗ Error setting lock:`, error);
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

              const partial: CachedTranslation = {
                content: cleanedText,
                status: "partial",
                timestamp: Date.now(),
                sourceLength: englishRaw.length,
                translatedLength: cleanedText.length,
              };

              await ghCache.set(cacheKey, JSON.stringify(partial));
              lastSaveLength = fullText.length;
              console.log(
                `[gh-cache] ✓ Saved partial (${fullText.length}/${englishRaw.length} chars): ${cacheKey}`
              );
            } catch (error) {
              console.error(`[gh-cache] ✗ Error saving partial:`, error);
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

            const complete: CachedTranslation = {
              content: cleanedText,
              status: "complete",
              timestamp: Date.now(),
              sourceLength: englishRaw.length,
              translatedLength: cleanedText.length,
            };

            await ghCache.set(cacheKey, JSON.stringify(complete));
            console.log(
              `[gh-cache] ✓ Saved complete (${fullText.length}/${englishRaw.length} chars): blog/${cacheKey}.md`
            );

            // Remove lock to indicate completion
            await ghCache.delete(lockKey);
            console.log(`[lock] ✓ Released lock for ${cacheKey}`);
          } catch (error) {
            console.error(`[gh-cache] ✗ Error saving final:`, error);
          }
        }
      } catch (error) {
        console.error(`[stream] ✗ Error during streaming:`, error);

        // Clean up lock on error
        if (ghCache) {
          try {
            await ghCache.delete(lockKey);
            console.log(`[lock] ✓ Released lock after error`);
          } catch (lockError) {
            console.error(`[lock] ✗ Error releasing lock:`, lockError);
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
        const cleanedText = fullText
          .replace(/^```markdown\s*\n?/, "")
          .replace(/\n?```\s*$/, "");

        const partial: CachedTranslation = {
          content: cleanedText,
          status: "partial",
          timestamp: Date.now(),
          sourceLength: englishRaw.length,
          translatedLength: cleanedText.length,
        };

        ghCache
          .set(cacheKey, JSON.stringify(partial))
          .then(() => {
            console.log(
              `[gh-cache] ✓ Saved partial after disconnect (${fullText.length}/${englishRaw.length} chars)`
            );
            return ghCache.delete(lockKey);
          })
          .then(() => console.log(`[lock] ✓ Released lock after disconnect`))
          .catch((error) => console.error(`[gh-cache] ✗ Error in cancel:`, error));
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
