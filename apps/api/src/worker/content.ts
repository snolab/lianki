import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import { BLOG_LOCALES, LOCALE_NAMES } from "@/lib/constants";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import { resolveEmail } from "./session";
import { openaiChatJSON, openaiChatStream, openaiSpeech } from "./openai";

// CF-native ports of the top-level content routes: blog `translate` (streaming),
// `tts` (R2-cached speech), and `roadmap/generate` (structured JSON). OpenAI is
// called via the shared Workers-native fetch helpers (no `ai`/`openai` SDK).

const RL_WINDOW = 10 * 60_000;

function rateLimited(c: any, key: string, max: number): Response | null {
  const rl = checkRateLimit(key, { windowMs: RL_WINDOW, max });
  if (rl.allowed) return null;
  return c.json({ error: "Too many requests. Please retry later." }, 429, {
    "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
  });
}

// ── translate ────────────────────────────────────────────────────────────────
const MAX_SOURCE_LENGTH = 50_000;
const TRANSLATE_SYSTEM = `You are a professional technical translator. Translate markdown blog posts accurately while:
- Preserving ALL markdown formatting (headers, bold, italic, lists, tables, code blocks)
- Preserving ALL code snippets exactly as-is (do not translate code inside backticks or code fences)
- Translating frontmatter fields: title, summary, and tags (translate tag text but keep array structure)
- Keeping frontmatter keys (title, date, tags, summary) in English
- Keeping the date field unchanged
- Preserving all URLs and links unchanged
- Outputting ONLY the translated markdown, no commentary`;

/**
 * Fetch the English source markdown for `slug`. The Next route read it from the
 * local filesystem (`blog/en/*.md`) — not available on Workers — so we fetch the
 * committed source from GitHub raw. The GitHub-commit cache/lock layers of the
 * original are intentionally dropped (KeyvGitHub/Octokit aren't Worker-portable).
 */
async function fetchEnglishSource(slug: string): Promise<string | null> {
  const res = await fetch(
    `https://raw.githubusercontent.com/snomiao/lianki/main/blog/en/${slug}.md`,
  );
  if (!res.ok) return null;
  return res.text();
}

// ── tts ──────────────────────────────────────────────────────────────────────
const TTS_MAX_TEXT_LENGTH = 4096;
const TTS_ALLOWED_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const TTS_ALLOWED_MODELS = ["tts-1", "tts-1-hd"];
const R2_TTS_PREFIX = "tts/"; // mirrors lib/ttsCache.ts so caches interop

// ── roadmap/generate ─────────────────────────────────────────────────────────
const RoadmapSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string().max(200),
        keywords: z.array(z.string()).min(2).max(8),
        order: z.number(),
      }),
    )
    .min(3)
    .max(12),
});

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountContentRoutes(app: Hono<any>) {
  // ── Blog translate (streaming, token-or-session authed) ──────────────────────
  app.get("/api/translate", async (c: any) => {
    const url = new URL(c.req.raw.url);
    const slug = url.searchParams.get("slug");
    const locale = url.searchParams.get("locale");

    if (!slug || !locale) return c.text("Missing slug or locale", 400);
    if (!BLOG_LOCALES.includes(locale as (typeof BLOG_LOCALES)[number]))
      return c.text("Unsupported locale", 400);
    if (locale === "en") return c.text("Cannot translate to source locale", 400);
    if (!/^[a-z0-9-]+$/.test(slug)) return c.text("Invalid slug", 400);

    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.text("Unauthorized", 401);

    const limited = rateLimited(c, `blog-translate:${email}`, 8);
    if (limited) return limited;

    const apiKey = c.env.OPENAI_API_KEY;
    if (!apiKey) return c.text("OPENAI_API_KEY not configured", 500);

    const englishRaw = await fetchEnglishSource(slug);
    if (!englishRaw) return c.text("Post not found", 404);
    if (englishRaw.length > MAX_SOURCE_LENGTH)
      return c.text("Source post too large to translate", 413);

    const targetLanguage = LOCALE_NAMES[locale] ?? locale;
    try {
      const stream = await openaiChatStream(apiKey, {
        model: "gpt-4o",
        system: TRANSLATE_SYSTEM,
        prompt: `Translate the following markdown blog post to ${targetLanguage}:\n\n${englishRaw}`,
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Cache-Status": "MISS",
        },
      });
    } catch (e) {
      logSanitizedError("translate.stream", e, { slug, locale });
      return c.text("Failed to translate", 500);
    }
  });

  // ── Text-to-speech (session/token authed, R2-cached) ─────────────────────────
  app.post("/api/tts", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.json({ error: "Unauthorized" }, 401);

    const limited = rateLimited(c, `tts:${email}`, 60);
    if (limited) return limited;

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { text, voice = "shimmer", model = "tts-1" } = body || {};
    if (typeof text !== "string" || text.length === 0)
      return c.json({ error: "text is required" }, 400);
    if (text.length > TTS_MAX_TEXT_LENGTH)
      return c.json(
        { error: `Text exceeds maximum length of ${TTS_MAX_TEXT_LENGTH} characters` },
        400,
      );
    if (!TTS_ALLOWED_VOICES.includes(voice))
      return c.json({ error: `Invalid voice. Allowed: ${TTS_ALLOWED_VOICES.join(", ")}` }, 400);
    if (!TTS_ALLOWED_MODELS.includes(model))
      return c.json({ error: `Invalid model. Allowed: ${TTS_ALLOWED_MODELS.join(", ")}` }, 400);

    const cacheKey = createHash("sha256").update(`${model}:${voice}:${text}`).digest("hex");
    const blobs = c.env.BLOBS as R2Bucket;

    try {
      const cached = await blobs.get(R2_TTS_PREFIX + cacheKey);
      if (cached) {
        return new Response(await cached.arrayBuffer(), {
          headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" },
        });
      }
    } catch (err) {
      logSanitizedError("tts.cache.lookup", err, { requester: email });
    }

    const apiKey = c.env.OPENAI_API_KEY;
    if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

    let audio: ArrayBuffer;
    try {
      audio = await openaiSpeech(apiKey, { model, voice, input: text });
    } catch (err) {
      logSanitizedError("tts.openai.generate", err, { requester: email });
      return c.json({ error: "Failed to generate speech" }, 500);
    }

    try {
      await blobs.put(R2_TTS_PREFIX + cacheKey, audio, {
        customMetadata: {
          model,
          voice,
          textHash: cacheKey,
          textLength: String(text.length),
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logSanitizedError("tts.cache.save", err, { requester: email, cacheKey });
    }

    return new Response(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" },
    });
  });

  // ── Roadmap generation (structured JSON, token-or-session authed) ────────────
  app.post("/api/roadmap/generate", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.text("Unauthorized", 401);

    const { topic } = await c.req.json().catch(() => ({}));
    if (!topic || typeof topic !== "string" || topic.length > 500)
      return c.text("Invalid topic", 400);

    const apiKey = c.env.OPENAI_API_KEY;
    if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

    try {
      const raw = await openaiChatJSON(
        apiKey,
        [
          {
            role: "system",
            content: `You generate structured learning roadmaps. Return ONLY a JSON object matching:
{ "nodes": [ { "id": string (snake_case), "title": string (max 50 chars), "description": string (max 200 chars), "keywords": string[] (2-8 items), "order": number (0-based) } ] }
Provide 5-10 progressive milestones from fundamentals to advanced. Keywords should be specific enough to match real study cards/URLs.`,
          },
          { role: "user", content: `Generate a learning roadmap for: "${topic}"` },
        ],
        0.7,
      );
      const parsed = RoadmapSchema.safeParse(raw);
      if (!parsed.success) {
        logSanitizedError("roadmap.generate.validate", parsed.error, { topic });
        return c.json({ error: "Failed to generate roadmap" }, 500);
      }
      return c.json(parsed.data);
    } catch (e) {
      logSanitizedError("roadmap.generate", e, { topic });
      return c.json({ error: "Failed to generate roadmap" }, 500);
    }
  });
}
