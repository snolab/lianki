// The I/O of the reader's Translate (the rules: lib/read/translate.ts): the
// shared cache (D1 read_translation), the model for what it lacks, and the
// real cost settled through the one charge seam (chargeAi, gloss-server.ts).
import type { D1Like } from "@/lib/d1/types";
import { PARTNER_AI_MODEL, PARTNER_AI_REASONING, costUsd } from "@/lib/partner-ai-config";
import { checkRateLimit } from "@/lib/rateLimit";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import { chargeAi, workersAiComplete, type Complete } from "./gloss-server";
import { cleanTranslation, normText, translateMessages, translationKey } from "./translate";

/** Model calls per user per window: a guard against runaway cost, not a quota shown to anyone. */
const AI_LIMIT = { windowMs: 10 * 60_000, max: 60 };
/** The answer's ceiling: a translation runs to a few tokens per source character at most. */
const maxTokens = (chars: number) => Math.min(8000, 200 + chars * 2);

export type TranslateResult =
  | { ok: true; text: string; cached: boolean }
  | { ok: false; error: "empty" | "not-configured" | "busy" | "model-failed" };

/**
 * `text` in `to` (a BCP 47 code): the cached translation when there is one,
 * else the model's — written to the cache before it is returned, its real
 * cost settled against the user.
 */
export async function translate(
  db: D1Like,
  input: { text: string; to: string; from: string | null },
  ai: { userId: string; complete?: Complete },
): Promise<TranslateResult> {
  const text = normText(input.text);
  if (!text) return { ok: false, error: "empty" };
  const key = await translationKey(input.to, text);
  const hit = await db
    .prepare("SELECT out FROM read_translation WHERE key = ?")
    .bind(key)
    .first<{ out: string }>();
  if (hit) return { ok: true, text: hit.out, cached: true };

  const complete = ai.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  if (!complete) return { ok: false, error: "not-configured" };
  if (!checkRateLimit(`read-translate:${ai.userId}`, AI_LIMIT).allowed)
    return { ok: false, error: "busy" };
  let out = "";
  let usd = 0;
  try {
    const r = await complete({
      model: PARTNER_AI_MODEL,
      messages: translateMessages(text, input.to, input.from),
      max_tokens: maxTokens(text.length),
      temperature: 0.2,
      reasoning_effort: PARTNER_AI_REASONING,
    });
    usd = costUsd(r.usage?.prompt_tokens ?? 0, r.usage?.completion_tokens ?? 0);
    out = cleanTranslation(r.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    console.error("read.translate: model failed", String(err).slice(0, 200));
  }
  if (usd > 0) await chargeAi(ai.userId, { usd, what: "read.translate", chars: text.length });
  if (!out) return { ok: false, error: "model-failed" };
  await db
    .prepare(
      "INSERT INTO read_translation (key, target, out, model, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
    )
    .bind(key, input.to, out, PARTNER_AI_MODEL, new Date().toISOString())
    .run();
  return { ok: true, text: out, cached: false };
}
