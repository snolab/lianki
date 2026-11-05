// The I/O of the transcript polish (the rules: lib/read/polish.ts): the
// model per chunk, its real cost settled through the one charge seam
// (chargeAi), and a per-user limit. Nothing about the text is logged.
import { PARTNER_AI_MODEL, PARTNER_AI_REASONING, costUsd } from "@/lib/partner-ai-config";
import { checkRateLimit } from "@/lib/rateLimit";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import { chargeAi, workersAiComplete, type Complete } from "./gloss-server";
import { checkPolish, polishMessages, type PolishChunk } from "./polish";

/** Polishes per user per window: each is a whole document's worth of calls. */
const POLISH_LIMIT = { windowMs: 10 * 60_000, max: 3 };
/** Calls in flight at once for one document. */
const PARALLEL = 4;
/** A document's chunk count past which it is refused (a guard against runaway cost, not shown). */
export const POLISH_MAX_CHUNKS = 400;
/** The answer's ceiling: the same text back, with punctuation. */
const maxTokens = (chars: number) => Math.min(8000, 200 + chars * 2);

export type PolishRun =
  | { ok: true; polished: (string[] | null)[] }
  | { ok: false; error: "not-configured" | "busy" | "too-long" | "model-failed" };

export async function polishChunksAi(
  chunks: readonly PolishChunk[],
  ai: { userId: string; complete?: Complete },
): Promise<PolishRun> {
  if (chunks.length > POLISH_MAX_CHUNKS) return { ok: false, error: "too-long" };
  const complete = ai.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  if (!complete) return { ok: false, error: "not-configured" };
  if (!checkRateLimit(`read-polish:${ai.userId}`, POLISH_LIMIT).allowed)
    return { ok: false, error: "busy" };
  const polished: (string[] | null)[] = chunks.map(() => null);
  let usd = 0;
  let chars = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++;
      const text = chunks[k].text;
      chars += text.length;
      try {
        const r = await complete({
          model: PARTNER_AI_MODEL,
          messages: polishMessages(text),
          max_tokens: maxTokens(text.length),
          temperature: 0.1,
          reasoning_effort: PARTNER_AI_REASONING,
        });
        usd += costUsd(r.usage?.prompt_tokens ?? 0, r.usage?.completion_tokens ?? 0);
        polished[k] = checkPolish(text, r.choices?.[0]?.message?.content ?? "");
      } catch (err) {
        // The error only: never the text.
        console.error("read.polish: model failed", String(err).slice(0, 200));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
  if (usd > 0) await chargeAi(ai.userId, { usd, what: "read.polish", chars });
  console.log(
    JSON.stringify({
      event: "read.polish",
      chunks: chunks.length,
      kept: polished.filter(Boolean).length,
    }),
  );
  if (!polished.some(Boolean)) return { ok: false, error: "model-failed" };
  return { ok: true, polished };
}
