// The model call of the live polish (rules: live-polish.ts). Nothing about the
// text is logged.
import { PARTNER_AI_REASONING, costUsd } from "@/lib/partner-ai-config";
import { routeLimit } from "@/lib/security/route-guard";
import { isWorkersAiConfigured } from "@/lib/workers-ai";
import { chargeAi, workersAiComplete, type Complete } from "./gloss-server";
import { LIVE_POLISH_MODEL, checkLivePolish, livePolishMessages } from "./live-polish";

/** Calls per user per window: a live talk makes a few a minute. */
const LIMIT = { windowMs: 10 * 60_000, max: 120 };
/** The answer's ceiling: about the same text back. */
const maxTokens = (chars: number) => Math.min(8000, 300 + chars * 2);

export type LivePolish =
  | { ok: true; text: string }
  | { ok: false; error: "not-configured" | "busy" | "model-failed" };

export async function livePolishAi(
  text: string,
  before: string,
  ai: { userId: string; complete?: Complete; model?: string },
): Promise<LivePolish> {
  const complete = ai.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  if (!complete) return { ok: false, error: "not-configured" };
  if (!(await routeLimit(`read-live-polish:${ai.userId}`, LIMIT)).allowed)
    return { ok: false, error: "busy" };
  try {
    const r = await complete({
      model: ai.model || process.env.READ_POLISH_MODEL || LIVE_POLISH_MODEL,
      messages: livePolishMessages(text, before),
      max_tokens: maxTokens(text.length),
      temperature: 0.2,
      reasoning_effort: PARTNER_AI_REASONING,
    });
    const usd = costUsd(r.usage?.prompt_tokens ?? 0, r.usage?.completion_tokens ?? 0);
    if (usd > 0) await chargeAi(ai.userId, { usd, what: "read.live-polish", chars: text.length });
    const out = checkLivePolish(text, r.choices?.[0]?.message?.content);
    return out === null ? { ok: false, error: "model-failed" } : { ok: true, text: out };
  } catch (err) {
    // The error only: never the text.
    console.error("read.live-polish: model failed", String(err).slice(0, 200));
    return { ok: false, error: "model-failed" };
  }
}
