// The I/O of the reader's Translate (the rules: lib/read/translate.ts): the
// shared cache (D1 read_translation), the model for what it lacks, and the
// call paid from the user's credits through the one charge seam (payAi, gloss-server.ts).
import type { D1Like } from "@/lib/d1/types";
import { PARTNER_AI_MODEL, PARTNER_AI_REASONING } from "@/lib/partner-ai-config";
import { textHoldUsd, type Feature } from "@/lib/payments/prices";
import { routeLimit } from "@/lib/security/route-guard";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import {
  payAi,
  promptChars,
  usageUsd,
  workersAiComplete,
  type AiPayer,
  type Complete,
  type NoCredits,
} from "./gloss-server";
import { cleanTranslation, normText, translateMessages, translationKey } from "./translate";

/** Model calls per user per window: a guard against runaway cost, not a quota shown to anyone. */
const AI_LIMIT = { windowMs: 10 * 60_000, max: 60 };
/** The same guard for someone reading a live doc: the card follows every new sentence. */
export const AI_LIMIT_LIVE = { windowMs: 10 * 60_000, max: 600 };
/** The answer's ceiling: a translation runs to a few tokens per source character at most. */
const maxTokens = (chars: number) => Math.min(8000, 200 + chars * 2);

export type TranslateResult =
  | { ok: true; text: string; cached: boolean }
  | { ok: false; error: "empty" | "not-configured" | "busy" | "model-failed" }
  | ({ ok: false; error: "no-credits" } & NoCredits);

/**
 * `text` in `to` (a BCP 47 code): the cached translation when there is one,
 * else the model's — written to the cache before it is returned, its real
 * cost settled against the user.
 */
export async function translate(
  db: D1Like,
  input: { text: string; to: string; from: string | null; notes?: boolean },
  ai: AiPayer & {
    complete?: Complete;
    limit?: { windowMs: number; max: number };
    /** The feature charged (the usage view's label). */
    what?: Feature;
    /** Instead of the shared read_translation: a private text keeps its own (lib/vibe). */
    cache?: {
      get(key: string): Promise<string | null>;
      put(key: string, out: string, model: string): Promise<void>;
    };
  },
): Promise<TranslateResult> {
  const text = normText(input.text);
  if (!text) return { ok: false, error: "empty" };
  const key = await translationKey(input.to, text, input.notes);
  const hit = ai.cache
    ? await ai.cache.get(key)
    : ((
        await db
          .prepare("SELECT out FROM read_translation WHERE key = ?")
          .bind(key)
          .first<{ out: string }>()
      )?.out ?? null);
  if (hit) return { ok: true, text: hit, cached: true };

  const complete = ai.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  if (!complete) return { ok: false, error: "not-configured" };
  if (!(await routeLimit(`read-translate:${ai.userId}`, ai.limit ?? AI_LIMIT)).allowed)
    return { ok: false, error: "busy" };
  let out = "";
  const messages = translateMessages(text, input.to, input.from, input.notes);
  const maxOut = maxTokens(text.length);
  const hold = textHoldUsd(PARTNER_AI_MODEL, promptChars(messages), maxOut);
  try {
    const paid = await payAi(ai, ai.what ?? "read.translate", hold, async () => {
      const r = await complete({
        model: PARTNER_AI_MODEL,
        messages,
        max_tokens: maxOut,
        temperature: 0.2,
        reasoning_effort: PARTNER_AI_REASONING,
      });
      return { value: r, usd: usageUsd(PARTNER_AI_MODEL, r.usage, hold) };
    });
    if (!paid.ok)
      return paid.reason === "no-credits"
        ? { ok: false, error: "no-credits", balance: paid.balance, need: paid.need }
        : { ok: false, error: "busy" };
    out = cleanTranslation(paid.value.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    console.error("read.translate: model failed", String(err).slice(0, 200));
  }
  if (!out) return { ok: false, error: "model-failed" };
  if (ai.cache) await ai.cache.put(key, out, PARTNER_AI_MODEL);
  else
    await db
      .prepare(
        "INSERT INTO read_translation (key, target, out, model, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
      )
      .bind(key, input.to, out, PARTNER_AI_MODEL, new Date().toISOString())
      .run();
  return { ok: true, text: out, cached: false };
}
