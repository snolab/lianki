// The model call of the live polish (rules: live-polish.ts). Nothing about the
// text is logged.
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { PARTNER_AI_REASONING } from "@/lib/partner-ai-config";
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
  type NoCredits,
} from "./gloss-server";
import {
  LIVE_POLISH_MODEL,
  isDraftWord,
  livePolishMessages,
  parseLivePolish,
  type LivePolished,
} from "./live-polish";

/** Calls per user per window: a live talk makes a few a minute. */
const LIMIT = { windowMs: 10 * 60_000, max: 120 };
/** The answer's ceiling: about the same text back, in its tags. */
const maxTokens = (chars: number, passages: number) =>
  Math.min(8000, 300 + chars * 2 + passages * 20);

/** Tapping words of the draft: a card or a meaning at a time, by hand. */
const DRAFT_WORD_LIMIT = { windowMs: 10 * 60_000, max: 120 };

/** Who may have a live doc polished: the owner, or everyone once the flag is on. */
export async function mayPolishLive(email: string | null) {
  return isDev(email) || flagIn(await readFlags(), "read.live-polish");
}

/**
 * The words a gloss or card route takes with `draft: true`: the polish rewrites,
 * so the draft holds words no save of the book has, and nothing stores the draft
 * to check them against. So one word at a time, limited, and only for who may
 * polish; anyone else keeps the book's words. Null: over the limit.
 */
export async function draftOwn(
  own: (w: string) => boolean,
  ctx: { userId: string; email: string | null },
): Promise<((w: string) => boolean) | null> {
  if (!(await mayPolishLive(ctx.email))) return own;
  if (!(await routeLimit(`read-draft-word:${ctx.userId}`, DRAFT_WORD_LIMIT)).allowed) return null;
  return (w) => own(w) || isDraftWord(w);
}

export type LivePolish =
  | { ok: true; passages: LivePolished[] }
  | { ok: false; error: "not-configured" | "busy" | "model-failed" }
  | ({ ok: false; error: "no-credits" } & NoCredits);

export async function livePolishAi(
  passages: readonly string[],
  before: string,
  ai: AiPayer & { complete?: Complete; model?: string },
): Promise<LivePolish> {
  const complete = ai.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  if (!complete) return { ok: false, error: "not-configured" };
  if (!(await routeLimit(`read-live-polish:${ai.userId}`, LIMIT)).allowed)
    return { ok: false, error: "busy" };
  const chars = passages.reduce((n, p) => n + p.length, 0);
  const model = ai.model || process.env.READ_POLISH_MODEL || LIVE_POLISH_MODEL;
  const messages = livePolishMessages(passages, before);
  const maxOut = maxTokens(chars, passages.length);
  const hold = textHoldUsd(model, promptChars(messages), maxOut);
  try {
    const paid = await payAi(ai, "read.live-polish", hold, async () => {
      const r = await complete({
        model,
        messages,
        max_tokens: maxOut,
        temperature: 0.2,
        reasoning_effort: PARTNER_AI_REASONING,
      });
      return { value: r, usd: usageUsd(model, r.usage, hold) };
    });
    if (!paid.ok)
      return paid.reason === "no-credits"
        ? { ok: false, error: "no-credits", balance: paid.balance, need: paid.need }
        : { ok: false, error: "busy" };
    const content = paid.value.choices?.[0]?.message?.content;
    // Nothing back at all is a failed call, not a text of nothing but fillers.
    if (!content?.includes("<p ")) return { ok: false, error: "model-failed" };
    return { ok: true, passages: parseLivePolish(passages, content) };
  } catch (err) {
    // The error only: never the text.
    console.error("read.live-polish: model failed", String(err).slice(0, 200));
    return { ok: false, error: "model-failed" };
  }
}
