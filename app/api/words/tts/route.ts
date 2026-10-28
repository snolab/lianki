import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { authUserOrNull } from "@/app/signInEmail";
import {
  isWorkersAiConfigured,
  MELOTTS_LANGS,
  sniffAudioType,
  speechModel,
  workersAiSpeech,
} from "@/lib/workers-ai";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import { getCachedTTS, putCachedTTS } from "@/lib/ttsCache";

/**
 * Word audio for browsers that cannot speak (Firefox on Android has no usable
 * speech voices). The client asks only when its own speech fails, so most
 * study never reaches here.
 *
 * Cost: each (lang, text) is generated once, ever — kept in R2 and then in
 * the browser's HTTP cache for a year. Only cache misses are rate limited,
 * and text is capped at an example sentence's length.
 */
const MAX_TEXT = 200;
const MISS_WINDOW_MS = 10 * 60_000;
const MISS_MAX = 120;
const CACHE_HEADERS = { "Cache-Control": "private, max-age=31536000, immutable" };

export const GET = async (req: NextRequest) => {
  const user = await authUserOrNull();
  if (!user?.email) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const lang = req.nextUrl.searchParams.get("lang")?.toLowerCase().split(/[-_]/)[0] ?? "";
  const text = req.nextUrl.searchParams.get("text")?.trim() ?? "";
  if (!text || text.length > MAX_TEXT)
    return NextResponse.json({ error: `text: 1–${MAX_TEXT} characters` }, { status: 400 });
  // 404, not 400: the client remembers the language has no server voice.
  if (!MELOTTS_LANGS.has(lang))
    return NextResponse.json({ error: "No voice for this language" }, { status: 404 });

  const key = crypto
    .createHash("sha256")
    .update(`${speechModel()}:words:${lang}:${text}`)
    .digest("hex");
  try {
    const cached = await getCachedTTS(key);
    if (cached)
      return new Response(Buffer.from(cached), {
        headers: { "Content-Type": sniffAudioType(Buffer.from(cached)), ...CACHE_HEADERS },
      });
  } catch (err) {
    logSanitizedError("words.tts.cache.lookup", err, {});
  }

  const limit = checkRateLimit(`words-tts:${user.email}`, {
    windowMs: MISS_WINDOW_MS,
    max: MISS_MAX,
  });
  if (!limit.allowed)
    return NextResponse.json(
      { error: "Too many new words to voice; retry later" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  if (!isWorkersAiConfigured())
    return NextResponse.json({ error: "Speech is not configured" }, { status: 503 });

  try {
    const { audio, contentType } = await workersAiSpeech({ text, lang, signal: req.signal });
    try {
      await putCachedTTS(key, audio, { lang, textLength: text.length, source: "words" });
    } catch (err) {
      logSanitizedError("words.tts.cache.save", err, {});
    }
    return new Response(audio, { headers: { "Content-Type": contentType, ...CACHE_HEADERS } });
  } catch (err) {
    logSanitizedError("words.tts.generate", err, {});
    return NextResponse.json({ error: "Failed to generate speech" }, { status: 502 });
  }
};
