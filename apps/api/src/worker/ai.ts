import { Hono } from "hono";
import { createEmptyCard } from "ts-fsrs";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { newServerHLC } from "@/app/fsrs-helpers";
import { checkRateLimit } from "@/lib/rateLimit";
import { logSanitizedError } from "@/lib/safeError";
import type { D1Like } from "@/lib/d1/types";
import { resolveEmail } from "./session";

// CF-native ports of the AI vocab routes. OpenAI is called via direct fetch
// (Workers-native, no SDK in the bundle). Reuses the shared rateLimit/safeError
// utilities and the FSRS repo. OPENAI_API_KEY comes from a Worker secret.

const RL_WINDOW = 10 * 60_000;

type ChatMessage = { role: "system" | "user"; content: string };

async function openaiJSON(
  apiKey: string,
  messages: ChatMessage[],
  temperature: number,
): Promise<Record<string, unknown>> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      response_format: { type: "json_object" },
      temperature,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

function rateLimited(c: any, key: string, max: number): Response | null {
  const rl = checkRateLimit(key, { windowMs: RL_WINDOW, max });
  if (rl.allowed) return null;
  return c.json({ error: "Too many requests. Please retry later." }, 429, {
    "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountAiRoutes(app: Hono<any>) {
  app.post("/api/ai-sentences/generate", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const limited = rateLimited(c, `ai-sentences:${email}`, 40);
      if (limited) return limited;

      const { word, language, topic, historySentences } = await c.req.json();
      if (typeof word !== "string" || word.length === 0 || word.length > 100)
        return c.json({ error: "Invalid word" }, 400);
      if (typeof language !== "string" || language.length === 0)
        return c.json({ error: "Invalid language" }, 400);
      const apiKey = c.env.OPENAI_API_KEY;
      if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

      const historyContext =
        Array.isArray(historySentences) && historySentences.length > 0
          ? `\nAvoid reusing these previous sentences:\n${historySentences.slice(-10).join("\n")}`
          : "";
      const topicContext = topic ? `The sentence should relate to the topic: "${topic}".` : "";

      const result = await openaiJSON(
        apiKey,
        [
          {
            role: "system",
            content: `You are a language learning assistant. Generate a natural example sentence using the given word in ${language}.
Return a JSON object with these fields:
- "word": the target word
- "sentence": a natural sentence using the word (5-500 characters)
- "reading": phonetic transcription appropriate for the language (hiragana for Japanese, pinyin for Chinese, romanization for Korean, IPA for others)
- "explanation": a brief explanation of the sentence relating to the word and context (5-200 characters, in English)

${topicContext}${historyContext}`,
          },
          { role: "user", content: `Generate a sentence for the word: "${word}"` },
        ],
        0.8,
      );
      return c.json({
        word: result.word || word,
        sentence: result.sentence || "",
        reading: result.reading || "",
        explanation: result.explanation || "",
      });
    } catch (e) {
      logSanitizedError("ai-sentences.generate", e);
      return c.json({ error: "Failed to generate sentence" }, 500);
    }
  });

  app.post("/api/ai-sentences/new-word", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const limited = rateLimited(c, `ai-new-word:${email}`, 20);
      if (limited) return limited;

      const { topic, language, knownWords } = await c.req.json();
      if (typeof topic !== "string" || topic.length === 0 || topic.length > 500)
        return c.json({ error: "Invalid topic" }, 400);
      if (typeof language !== "string" || language.length === 0)
        return c.json({ error: "Invalid language" }, 400);
      const apiKey = c.env.OPENAI_API_KEY;
      if (!apiKey) return c.json({ error: "OpenAI API key not configured" }, 500);

      const knownWordsContext =
        Array.isArray(knownWords) && knownWords.length > 0
          ? `\nAVOID these words the user already knows: ${knownWords.join(", ")}`
          : "";

      const result = await openaiJSON(
        apiKey,
        [
          {
            role: "system",
            content: `You are a language learning assistant. Suggest a new vocabulary word in ${language} based on the given topic.
Return a JSON object with:
- "word": the vocabulary word in the target language
- "definition": a brief definition in English (under 100 characters)

Prefer common, high-frequency words that are useful for conversation.${knownWordsContext}`,
          },
          { role: "user", content: `Suggest a new word for the topic: "${topic}"` },
        ],
        0.9,
      );
      return c.json({ word: result.word || "", definition: result.definition || "" });
    } catch (e) {
      logSanitizedError("ai-sentences.new-word", e);
      return c.json({ error: "Failed to generate word" }, 500);
    }
  });

  app.post("/api/ai-sentences/save-cards", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const { words } = await c.req.json();
      if (!Array.isArray(words) || words.length === 0 || words.length > 100)
        return c.json({ error: "Invalid words array" }, 400);

      const repo = new FsrsNotesD1Repo(c.env.DB as D1Like, email);
      let saved = 0;
      let skipped = 0;
      for (const item of words) {
        const { word, definition, language } = item ?? {};
        if (!word || !language) {
          skipped++;
          continue;
        }
        const url = `lianki://ai-vocab/${encodeURIComponent(language)}/${encodeURIComponent(word)}/${Date.now()}`;
        try {
          await repo.upsert({
            url,
            title: `${word} — ${definition || ""}`,
            card: createEmptyCard(),
            hlc: newServerHLC(),
            log: [],
            notes: `[ai-vocab] ${language} | ${word}`,
          });
          saved++;
        } catch {
          skipped++;
        }
      }
      return c.json({
        success: true,
        saved,
        skipped,
        message: `Saved ${saved} cards${skipped > 0 ? `, skipped ${skipped}` : ""}`,
      });
    } catch (e) {
      logSanitizedError("ai-sentences.save-cards", e);
      return c.json({ error: "Failed to save cards" }, 500);
    }
  });
}
