import { Hono } from "hono";
import { createEmptyCard } from "ts-fsrs";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { newServerHLC } from "@/app/fsrs-helpers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import type { D1Like } from "@/lib/d1/types";
import { resolveEmail } from "./session";
import { openaiChatJSON, openaiSpeech } from "./openai";

// CF-native ports of the Polyglot routes (translate / tts / save-cards). The
// polyglot card metadata (language/questionId/question/answer) isn't a field on
// FSRSNote, so it's stashed as a JSON summary in the note's `notes` string.

const RL_WINDOW = 10 * 60_000;
const MAX_TEXT_LENGTH = 2000;
const TTS_MAX_TEXT_LENGTH = 1000;

function rateLimited(c: any, key: string, max: number): Response | null {
  const rl = checkRateLimit(key, { windowMs: RL_WINDOW, max });
  if (rl.allowed) return null;
  return c.json({ error: "Too many requests. Please retry later." }, 429, {
    "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountPolyglotRoutes(app: Hono<any>) {
  // ── Translate question + answer ──────────────────────────────────────────────
  app.post("/api/polyglot/translate", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const limited = rateLimited(c, `polyglot-translate:${email}`, 30);
      if (limited) return limited;

      const { question, answer, targetLanguage, sourceLanguage } = await c.req.json();
      if (
        typeof question !== "string" ||
        typeof answer !== "string" ||
        question.length === 0 ||
        answer.length === 0 ||
        question.length > MAX_TEXT_LENGTH ||
        answer.length > MAX_TEXT_LENGTH
      )
        return c.json({ error: "Invalid question or answer" }, 400);
      if (typeof sourceLanguage !== "string" || typeof targetLanguage !== "string")
        return c.json({ error: "Invalid source/target language" }, 400);

      const apiKey = c.env.OPENAI_API_KEY;
      if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

      const result = await openaiChatJSON(
        apiKey,
        [
          {
            role: "system",
            content: `You are a professional translator. You will receive a question and an answer in ${sourceLanguage}.
Translate both to ${targetLanguage}.
Return a JSON object with two fields: "question" and "answer".
Make the translations natural and conversational.`,
          },
          { role: "user", content: JSON.stringify({ question, answer }) },
        ],
        0.3,
      );
      return c.json({
        translatedQuestion: result.question || question,
        translatedAnswer: result.answer || answer,
      });
    } catch (e) {
      logSanitizedError("polyglot.translate", e);
      return c.json({ error: "Failed to translate" }, 500);
    }
  });

  // ── Text-to-speech ───────────────────────────────────────────────────────────
  app.post("/api/polyglot/tts", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const limited = rateLimited(c, `polyglot-tts:${email}`, 30);
      if (limited) return limited;

      const { text } = await c.req.json();
      if (typeof text !== "string" || text.length === 0 || text.length > TTS_MAX_TEXT_LENGTH)
        return c.json({ error: `Text must be 1-${TTS_MAX_TEXT_LENGTH} characters` }, 400);

      const apiKey = c.env.OPENAI_API_KEY;
      if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

      const audio = await openaiSpeech(apiKey, {
        model: "tts-1",
        voice: "nova",
        input: text,
        speed: 1.0,
      });
      return new Response(audio, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `attachment; filename="polyglot-${Date.now()}.mp3"`,
        },
      });
    } catch (e) {
      logSanitizedError("polyglot.tts", e);
      return c.json({ error: "Failed to generate audio" }, 500);
    }
  });

  // ── Save polyglot cards (matrix → FSRS notes) ────────────────────────────────
  app.post("/api/polyglot/save-cards", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const { matrix } = await c.req.json();
      if (!matrix || typeof matrix !== "object") return c.json({ error: "Invalid matrix" }, 400);

      const repo = new FsrsNotesD1Repo(c.env.DB as D1Like, email);
      let cardsCreated = 0;
      for (const [questionId, langData] of Object.entries(matrix)) {
        for (const [langCode, content] of Object.entries(
          (langData ?? {}) as Record<string, { question: string; answer: string }>,
        )) {
          const { question, answer } = content ?? {};
          if (typeof question !== "string" || typeof answer !== "string") continue;
          const url = `lianki://polyglot/${langCode}/${questionId}/${Date.now()}`;
          await repo.upsert({
            url,
            title: `[Polyglot ${langCode}] ${question}`,
            card: createEmptyCard(),
            hlc: newServerHLC(),
            log: [],
            notes: JSON.stringify({
              polyglot: { language: langCode, questionId, question, answer },
            }),
          });
          cardsCreated++;
        }
      }
      return c.json({
        success: true,
        cardsCreated,
        message: `${cardsCreated} polyglot cards saved successfully!`,
      });
    } catch (e) {
      logSanitizedError("polyglot.save-cards", e);
      return c.json({ error: "Failed to save cards" }, 500);
    }
  });
}
