// The I/O of the transcript polish (the rules: lib/read/polish.ts): the
// model per chunk, paid from the user's credits through the one charge seam
// (payAi: the chunks' most held first), and a per-user limit. Nothing about the text is logged.
import { refusedAs, type Refused } from "@/lib/payments/metered";
import { PARTNER_AI_MODEL, PARTNER_AI_REASONING } from "@/lib/partner-ai-config";
import { textHoldUsd } from "@/lib/payments/prices";
import { routeLimit } from "@/lib/security/route-guard";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import {
  payAi,
  promptChars,
  usageUsd,
  workersAiComplete,
  type AiPayer,
  type Complete,
} from "./gloss-server";
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
  | { ok: false; error: "not-configured" | "busy" | "too-long" | "model-failed" }
  | Refused;

export async function polishChunksAi(
  chunks: readonly PolishChunk[],
  ai: AiPayer & { complete?: Complete },
): Promise<PolishRun> {
  if (chunks.length > POLISH_MAX_CHUNKS) return { ok: false, error: "too-long" };
  const complete = ai.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  if (!complete) return { ok: false, error: "not-configured" };
  if (!(await routeLimit(`read-polish:${ai.userId}`, POLISH_LIMIT)).allowed)
    return { ok: false, error: "busy" };
  const polished: (string[] | null)[] = chunks.map(() => null);
  let usd = 0;
  let next = 0;
  const holdOf = (text: string) =>
    textHoldUsd(PARTNER_AI_MODEL, promptChars(polishMessages(text)), maxTokens(text.length));
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++;
      const text = chunks[k].text;
      try {
        const r = await complete({
          model: PARTNER_AI_MODEL,
          messages: polishMessages(text),
          max_tokens: maxTokens(text.length),
          temperature: 0.1,
          reasoning_effort: PARTNER_AI_REASONING,
        });
        usd += usageUsd(PARTNER_AI_MODEL, r.usage, holdOf(text));
        polished[k] = checkPolish(text, r.choices?.[0]?.message?.content ?? "");
      } catch (err) {
        // The error only: never the text.
        console.error("read.polish: model failed", String(err).slice(0, 200));
      }
    }
  };
  const hold = chunks.reduce((n, c) => n + holdOf(c.text), 0);
  const paid = await payAi(ai, "read.polish", hold, async () => {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
    return { value: null, usd };
  });
  if (!paid.ok) return refusedAs(paid, { ok: false, error: "busy" } as const);
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
