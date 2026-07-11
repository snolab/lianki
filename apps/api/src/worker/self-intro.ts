import { Hono } from "hono";
import { createEmptyCard } from "ts-fsrs";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { newServerHLC } from "@/app/fsrs-helpers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import type { D1Like } from "@/lib/d1/types";
import { resolveEmail } from "./session";
import { openaiChatText, openaiSpeech } from "./openai";

// CF-native ports of the Self-Intro routes (translate / tts / save-cards). The
// self-intro metadata (language/questionId/text) isn't a field on FSRSNote, so
// it's stashed as a JSON summary in the note's `notes` string.

const QUESTION_TEMPLATES: Record<string, string> = {
  name: "My name is {answer}.",
  from: "I am from {answer}.",
  age: "I am {answer} years old.",
  occupation: "I am a {answer}.",
  hobby: "I like {answer}.",
  languages: "I speak {answer}.",
};

const LANGUAGE_NAMES: Record<string, string> = {
  "en-US": "English",
  "zh-CN": "Chinese (Simplified)",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "es-ES": "Spanish",
  "fr-FR": "French",
  "de-DE": "German",
  "it-IT": "Italian",
  "pt-BR": "Portuguese",
  "ru-RU": "Russian",
};

const RL_WINDOW = 10 * 60_000;
const MAX_ANSWER_LENGTH = 200;
const TTS_MAX_TEXT_LENGTH = 500;
const ALLOWED_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

function rateLimited(c: any, key: string, max: number): Response | null {
  const rl = checkRateLimit(key, { windowMs: RL_WINDOW, max });
  if (rl.allowed) return null;
  return c.json({ error: "Too many requests. Please retry later." }, 429, {
    "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountSelfIntroRoutes(app: Hono<any>) {
  // ── Translate a templated self-intro sentence ────────────────────────────────
  app.post("/api/self-intro/translate", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const limited = rateLimited(c, `self-intro-translate:${email}`, 40);
      if (limited) return limited;

      const { answer, questionId, targetLanguage } = await c.req.json();
      if (typeof answer !== "string" || answer.length === 0 || answer.length > MAX_ANSWER_LENGTH)
        return c.json({ error: `Answer must be 1–${MAX_ANSWER_LENGTH} characters` }, 400);
      if (!Object.keys(QUESTION_TEMPLATES).includes(questionId))
        return c.json({ error: "Invalid questionId" }, 400);
      if (!Object.keys(LANGUAGE_NAMES).includes(targetLanguage))
        return c.json({ error: "Unsupported targetLanguage" }, 400);

      const apiKey = c.env.OPENAI_API_KEY;
      if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

      const englishSentence = QUESTION_TEMPLATES[questionId].replace("{answer}", answer);
      const targetLangName = LANGUAGE_NAMES[targetLanguage];

      const translatedText =
        (await openaiChatText(
          apiKey,
          [
            {
              role: "system",
              content: `You are a professional translator. Translate the given English sentence to ${targetLangName}.
Only return the translated sentence, nothing else.
Make it natural and appropriate for self-introduction.
If the target language is the same as the input, just return it as is.`,
            },
            { role: "user", content: englishSentence },
          ],
          0.3,
        )) || englishSentence;

      return c.json({ translatedText });
    } catch (e) {
      logSanitizedError("self-intro.translate", e);
      return c.json({ error: "Failed to translate" }, 500);
    }
  });

  // ── Text-to-speech ───────────────────────────────────────────────────────────
  app.post("/api/self-intro/tts", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const limited = rateLimited(c, `self-intro-tts:${email}`, 40);
      if (limited) return limited;

      const { text, voice = "nova", speed = 1.0 } = await c.req.json();
      if (typeof text !== "string" || text.length === 0 || text.length > TTS_MAX_TEXT_LENGTH)
        return c.json({ error: `Text must be 1–${TTS_MAX_TEXT_LENGTH} characters` }, 400);
      if (!ALLOWED_VOICES.includes(voice))
        return c.json({ error: `Invalid voice. Allowed: ${ALLOWED_VOICES.join(", ")}` }, 400);
      if (typeof speed !== "number" || speed < 0.25 || speed > 4.0)
        return c.json({ error: "Speed must be between 0.25 and 4.0" }, 400);

      const apiKey = c.env.OPENAI_API_KEY;
      if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

      const audio = await openaiSpeech(apiKey, { model: "tts-1", voice, input: text, speed });
      return new Response(audio, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `attachment; filename="self-intro-${Date.now()}.mp3"`,
        },
      });
    } catch (e) {
      logSanitizedError("self-intro.tts", e);
      return c.json({ error: "Failed to generate audio" }, 500);
    }
  });

  // ── Save self-intro cards (sentences → FSRS notes) ───────────────────────────
  app.post("/api/self-intro/save-cards", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const { language, sentences } = await c.req.json();
      if (!sentences || typeof sentences !== "object")
        return c.json({ error: "Invalid sentences" }, 400);

      const repo = new FsrsNotesD1Repo(c.env.DB as D1Like, email);
      let cardsCreated = 0;
      for (const [questionId, data] of Object.entries(sentences)) {
        const { text } = (data ?? {}) as { text?: string };
        if (typeof text !== "string") continue;
        const url = `lianki://self-intro/${language}/${questionId}/${Date.now()}`;
        await repo.upsert({
          url,
          title: `[Self-Intro ${language}] ${text}`,
          card: createEmptyCard(),
          hlc: newServerHLC(),
          log: [],
          notes: JSON.stringify({ selfIntro: { language, questionId, text } }),
        });
        cardsCreated++;
      }
      return c.json({
        success: true,
        cardsCreated,
        message: `${cardsCreated} self-introduction cards saved successfully!`,
      });
    } catch (e) {
      logSanitizedError("self-intro.save-cards", e);
      return c.json({ error: "Failed to save cards" }, 500);
    }
  });
}
