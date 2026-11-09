/**
 * The Learning Partner's AI replies (docs/partner-ai.md): every number in one
 * place. These are operational limits — a guard against runaway cost and
 * abuse — not quotas shown to users. Imported by both lianki-push's hub
 * (workers/push/src/debug.ts: caps, routing) and the main Worker
 * (lib/partner-ai.ts: the model call), so it imports nothing.
 */

/** The owner's switch at /dev/flags (lib/flags.ts). Off: nothing routes to the model. */
export const PARTNER_AI_FLAG = "partner.ai-reply";

/**
 * DeepSeek on Cloudflare Workers AI (verified listed by `wrangler ai models`,
 * 2026-11-03). Called over the OpenAI-compatible REST endpoint with the
 * existing CLOUDFLARE_AI_TOKEN: no new secret, no third-party API.
 */
export const PARTNER_AI_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
/** Chat needs no thinking: faster and far fewer output tokens. */
export const PARTNER_AI_REASONING = "none";

/** List prices on the model's page (2026-11-03), USD per million tokens. */
export const PRICE_IN_PER_M = 0.3;
export const PRICE_OUT_PER_M = 1.2;

/** Most output tokens per reply (a short chat answer is ~100–300). */
export const MAX_OUTPUT_TOKENS = 600;
/** The thread's latest lines sent as memory (of the CHAT_HISTORY the hub keeps). */
export const HISTORY_LINES = 20;
/** Each history line is cut to this many characters. */
export const MAX_LINE_CHARS = 2000;
/** All history lines together (the newest kept): bounds the prompt, and so the reservation. */
export const HISTORY_MAX_CHARS = 12_000;
/** The rules plus the study summary, at most (lib/partner-ai.ts cuts the summary to fit). */
export const PROMPT_OVERHEAD_CHARS = 10_000;
/**
 * The reservation's tokens per character: a ceiling, not an estimate (Latin
 * text is ~0.3, CJK ~0.7–1, emoji up to ~2). The real counts replace it after.
 */
export const RESERVE_TOKENS_PER_CHAR = 2;
/** The page text (selection, screen) the model may see, in characters. */
export const MAX_PAGE_CHARS = 3000;
/** The reply posted into the chat is cut to this many characters. */
export const MAX_REPLY_CHARS = 2000;
/** The model call gives up after this long (the page's spinner shows meanwhile). */
export const MODEL_TIMEOUT_MS = 30_000;

/**
 * A credit reservation still pending this long after it was taken belongs to
 * a reply that crashed before settling (no call lasts near this long): the
 * next reply's sweep refunds it in full (lib/payments/ai-credits.ts).
 */
export const CHARGE_STALE_MS = 10 * 60_000;

/** Per user, per JST day: input + output tokens (≈ 40–80 typical messages). */
export const USER_DAILY_TOKENS = 60_000;
/** Whole site, per JST day, in USD at the list prices above. */
export const SITE_DAILY_USD = 2;

/** The label on the AI's lines (the agent's name on them is the chat's own, "Learning Partner"). */
export const PARTNER_AI_LABEL = "Learning Partner AI";

/** USD for one call's tokens. */
export const costUsd = (tokensIn: number, tokensOut: number) =>
  (tokensIn * PRICE_IN_PER_M + tokensOut * PRICE_OUT_PER_M) / 1_000_000;

/** The JST calendar day (YYYY-MM-DD) of an epoch-ms time: when the daily caps reset (00:00 JST). */
export const jstDay = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

/** What the hub sends the main Worker (DebugSessions.partnerReply). */
export type PartnerRequest = {
  /** The hub-verified user id of the thread (never chosen by the model or the page). */
  userId: string;
  /**
   * The user's line id: the credits' idempotency key (with userId), so a
   * retried request is charged once. An older hub sends none (a fresh key).
   */
  msgId?: string;
  /** The thread's latest lines, oldest first: the user's and the agent's. */
  history: { role: "user" | "assistant"; text: string }[];
  /** Where the user is: the page's path (from its label) and what the line carried. */
  page?: { path?: string; title?: string; selection?: string; screen?: string };
};

export type PartnerResult =
  | {
      ok: true;
      text: string;
      tokensIn: number;
      tokensOut: number;
      ms: number;
      model: string;
      /** Whole credits kept from the reservation for this reply (the fraction carries over). */
      charged?: number;
    }
  | {
      ok: false;
      /**
       * "no-credits": the balance does not cover this reply's worst case, so
       * the model was not called. "duplicate": this line was already answered
       * (or is being answered); nothing done.
       */
      error:
        | "bad-input"
        | "off"
        | "owner"
        | "no-user"
        | "not-configured"
        | "model-failed"
        | "busy"
        | "no-credits"
        | "duplicate";
      ms?: number;
      /**
       * After the model was asked: "no" = it answered an error status (no
       * inference billed); "unknown" = timeout, network or unreadable answer.
       * Absent on refusals before any call. The hub refunds only "no" and refusals.
       */
      billed?: "no" | "unknown";
      /** "no-credits": whole credits one reply needs (its hold), and the balance. */
      need?: number;
      have?: number;
      /** The model's reported usage, when it answered but its text was unusable. */
      tokensIn?: number;
      tokensOut?: number;
    };

/** The most input tokens a request of `chars` characters (history + page) can cost. */
export const reserveInTokens = (chars: number) =>
  Math.ceil((chars + PROMPT_OVERHEAD_CHARS) * RESERVE_TOKENS_PER_CHAR);
