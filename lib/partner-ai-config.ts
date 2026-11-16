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
 * The owner's own thread answered by the model too (docs/partner-ai.md,
 * "The owner's thread"), on top of PARTNER_AI_FLAG: only his unaddressed
 * lines that no lane answered within OWNER_REPLY_DELAY_MS.
 */
export const PARTNER_OWNER_FLAG = "partner.owner-thread";
/** The live value's key (lib/config.ts) for how long the lanes have before the model answers. */
export const OWNER_REPLY_DELAY_KEY = "partner.ownerReplyDelayMs";
/** Its default: 30 s for a lane to answer first (2026-11-15: lanes take 20–40 s; at 8 s Li cut in while 小克 typed). */
export const OWNER_REPLY_DELAY_MS = 30_000;
export const OWNER_REPLY_DELAY_MAX = 120_000;
/**
 * Li told to stop in his thread (owner, 2026-11-16 13:3x JST: "我已经要求他闭嘴了"):
 * a line of his holding one of the stop phrases (case-insensitive, anywhere in
 * the line, a line naming no lane) keeps Li silent this long, unless he
 * addresses Li by one of its names first (OWNER_LI_NAMES). Keys of lib/config.ts.
 */
export const OWNER_QUIET_KEY = "partner.ownerQuietMs";
export const OWNER_QUIET_MS = 10 * 60_000;
export const OWNER_QUIET_MAX = 24 * 60 * 60_000;
export const OWNER_STOP_PHRASES_KEY = "partner.stopPhrases";
/** Phrases, not language rules: any language's entries go in the same list. */
export const OWNER_STOP_PHRASES: readonly string[] = [
  "没问你",
  "不是问你",
  "不是在问你",
  "没跟你说",
  "不是跟你说",
  "不是和你说",
  "没叫你",
  "闭嘴",
  "别说了",
  "别说话",
  "不要说话",
  "别插嘴",
  "不要插嘴",
  "别回答",
  "不要回答",
  "不用你回答",
  "你别回",
  "安静点",
  "安静一下",
  "shut up",
  "be quiet",
  "stop talking",
  "not you",
  "not asking you",
  "黙って",
  "静かにして",
  "あなたじゃない",
];
/**
 * Li's own names (the main lane has no route): a line starting with one, then a
 * mark or nothing ("Li，…", "Li?"), addresses Li and ends a quiet spell; the
 * lanes' recent activity does not hold it back either.
 */
export const OWNER_LI_NAMES_KEY = "partner.liNames";
export const OWNER_LI_NAMES: readonly string[] = ["Li", "Lee", "学习伙伴", "learning partner"];
/**
 * While a lane talks with him (an agent line other than Li's within this
 * long), Li does not answer his unaddressed lines: they are most likely part
 * of that conversation (2026-11-16: Li answered a line meant for 哈基米).
 */
export const OWNER_LANE_ACTIVE_KEY = "partner.laneActiveMs";
export const OWNER_LANE_ACTIVE_MS = 5 * 60_000;
export const OWNER_LANE_ACTIVE_MAX = 60 * 60_000;

/**
 * Li's roll-call answer in his thread, no model (workers/push/src/owner-ai.ts;
 * packages/debug-chat/src/roster.ts rollCallText): the live value's key and
 * its default. `{n}` = how many are present besides Li, `{names}` = who.
 */
export const ROLL_CALL_REPLY_KEY = "partner.rollCallReply";
/** Only Li's own presence: the owner wants every lane to answer for itself (2026-11-15 14:2x JST "不要别人代答"). */
export const ROLL_CALL_REPLY_DEFAULT = "Li 在";

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

/**
 * A credit reservation still pending this long after it was taken belongs to
 * a reply that crashed before settling (no call lasts near this long): the
 * next reply's sweep refunds it in full (lib/payments/ai-credits.ts).
 */
export const CHARGE_STALE_MS = 10 * 60_000;

/**
 * Defaults of the caps' live values (lib/config.ts, read by the hub):
 * per user, over the rolling cap window (CAP_WINDOW_HOURS, by default the last
 * 24 hours), input + output tokens (≈ 40–80 typical messages). The name keeps
 * "DAILY" from when the caps reset on a calendar day; no day boundary remains.
 */
export const USER_DAILY_TOKENS = 60_000;
/** The live value's key for the per-user tokens over the window. */
export const USER_WINDOW_TOKENS_KEY = "partner.userWindowTokens";
export const USER_WINDOW_TOKENS_MAX = 10_000_000;
/** Whole site, over the same rolling window, in USD at the list prices above (default). */
export const SITE_DAILY_USD = 2;
/** The live value's key for the site's USD over the window. */
export const SITE_WINDOW_USD_KEY = "partner.siteWindowUsd";
export const SITE_WINDOW_USD_MAX = 1000;
/** The live value's key (lib/config.ts): how many hours the caps' rolling window spans. */
export const CAP_WINDOW_KEY = "partner.capWindowHours";
/** Its default: the last 24 hours (hourly UTC buckets, lib/rolling-window.ts). */
export const CAP_WINDOW_HOURS = 24;
export const CAP_WINDOW_MAX = 168;

/** The label on the AI's lines (the agent's name on them is the chat's own, "Learning Partner"). */
export const PARTNER_AI_LABEL = "Learning Partner AI";

/** USD for one call's tokens. */
export const costUsd = (tokensIn: number, tokensOut: number) =>
  (tokensIn * PRICE_IN_PER_M + tokensOut * PRICE_OUT_PER_M) / 1_000_000;

/** What the hub sends the main Worker (DebugSessions.partnerReply). */
export type PartnerRequest = {
  /** The hub-verified user id of the thread (never chosen by the model or the page). */
  userId: string;
  /**
   * The user's line id: the credits' idempotency key (with userId), so a
   * retried request is charged once. An older hub sends none (a fresh key).
   */
  msgId?: string;
  /**
   * The owner's own thread (PARTNER_OWNER_FLAG): the hub sets it only there,
   * and the main Worker then serves the account only if it is the owner's.
   */
  owner?: true;
  /**
   * The owner's thread only: who is present there (the hub's presence list,
   * packages/debug-chat/src/roster.ts rosterOf), for Li's "who is here" prompt block.
   */
  roster?: { id: string; name: string; mode?: "listener" | "reader"; muted?: true }[];
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
