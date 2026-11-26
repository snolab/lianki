/**
 * Chat wake, the pure part (docs/chat-wake.md): the event, the wake adapter
 * interface, the event id, the cursor, the limits and the pull answers. No
 * D1, no fetch, no clock: unit/chat-wake.test.ts pins it on synthetic data.
 *
 * A person writes `@<token name>` in that token's own thread. The core
 * (core.ts) keeps one `chat_mention` row per token and line, then hands the
 * token's new events to every enabled adapter through one `wake()`. Push
 * adapters deliver (ChatGPT: the MCP Events webhook, lib/mcp-events). The pull
 * adapter delivers nothing: its clients read the rows (pull.ts). A planned
 * local adapter (`ay`) is a pull client too: a listener on the owner's Mac
 * maps a token to an `ay` agent id and calls `ay send`; no server push.
 */
import type { ConfigValues } from "@/lib/config";

export const WAKE_PULL_FLAG = "chat.wake.pull" as const;

/** One mention: a person's line naming one token, in that token's own thread. */
export type WakeEvent = {
  /** men_ + hash(token, line): the dedupe key, the row's id, the poll eventId. */
  id: string;
  tokenHash: string;
  thread: string;
  lineId: string;
  text: string;
  author: "owner" | "friend";
  createdAt: number;
  /** False when this token and line were already recorded (a line put again). */
  fresh: boolean;
};

/** The live token a wake is for: checked by hash just before (principal). */
export type WakeTarget = { tokenHash: string; userId: string; name: string; thread: string };

/** Why a token named by an adapter cannot be woken now. */
export type NotLive = "auth" | "scope" | "audience" | "thread";

/** What one fan-out did, summed over adapters (the webhook's counts as before). */
export type WakeReport = {
  delivered: number;
  skipped: number;
  dropped: number;
  /** New chat_mention rows. */
  recorded: number;
};

/**
 * One way of waking an agent. Every adapter is gated by its own flag
 * (`enabled`, read live, fail closed) on top of the core's `mcp.events`.
 *
 * - push (ChatGPT webhook): holds routes in D1, so it names the tokens it can
 *   reach in a thread (`tokensIn`), hears when one is not live (`notLive`),
 *   and delivers in `wake`.
 * - pull (the tool and events/poll): `wake` is a no-op; the row is the
 *   delivery. The client reads it with its own token.
 * - planned: `ay` (local CLIs) is a pull client; Claude Code Routines or
 *   Channels and a hosted BYOK reply (DeepSeek and others) are push adapters
 *   with this same shape.
 */
export interface WakeAdapter<D> {
  id: string;
  mode: "push" | "pull";
  enabled(d: D): Promise<boolean>;
  tokensIn?(d: D, thread: string, now: number): Promise<string[]>;
  notLive?(
    d: D,
    tokenHash: string,
    thread: string,
    why: NotLive,
    report: WakeReport,
  ): Promise<void>;
  wake(d: D, target: WakeTarget, events: WakeEvent[], report: WakeReport): Promise<void>;
}

/** Drop repeats of an event id, keeping the first: one wake per event. */
export function dedupe(events: WakeEvent[]): WakeEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

const enc = new TextEncoder();
async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic per token and line: a repeated put of the line is the same event. */
export async function mentionId(tokenHash: string, lineId: string): Promise<string> {
  return `men_${(await sha256(`${tokenHash}\0${lineId}`)).slice(0, 32)}`;
}

// ------------------------------------------------------------ limits

export type WakeLimits = {
  retentionMs: number;
  perMinute: number;
  maxTokens: number;
  pullTtlMs: number;
  pullLimit: number;
  pullPerMinute: number;
  nextPollMs: number;
};

const MIN = 60_000;
export function wakeLimits(c: ConfigValues): WakeLimits {
  return {
    retentionMs: c["chat.wakeRetentionDays"] * 1440 * MIN,
    perMinute: c["chat.wakePerMinute"],
    maxTokens: c["chat.wakeMaxTokens"],
    pullTtlMs: c["chat.wakePullTtlMin"] * MIN,
    pullLimit: c["chat.wakePullLimit"],
    pullPerMinute: c["chat.wakePullPerMinute"],
    nextPollMs: c["chat.wakeNextPollMs"],
  };
}

// ------------------------------------------------------------ the cursor

/**
 * Opaque to clients: `w1.<seq>.<issued ms>`. `seq` is the last row seen (the
 * table's AUTOINCREMENT, never reused); `issued` tells whether rows past it
 * may already have been deleted by retention (then `truncated`).
 */
export type Cursor = { seq: number; issued: number };

export const encodeCursor = (c: Cursor) => `w1.${c.seq}.${c.issued}`;

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const m = /^w1\.(\d{1,15})\.(\d{1,15})$/.exec(raw);
  if (!m) return null;
  return { seq: Number(m[1]), issued: Number(m[2]) };
}

/** May rows after this cursor already be gone (older than retention)? */
export const cursorTruncated = (c: Cursor, now: number, l: WakeLimits) =>
  c.issued < now - l.retentionMs;

/** The most rows one pull returns, whatever is asked or configured. */
export const MAX_PAGE = 100;

/** How many to return: asked, else the default; at most MAX_PAGE. null: not a count. */
export function pageSize(asked: unknown, l: WakeLimits): number | null {
  if (asked === undefined || asked === null) return Math.min(l.pullLimit, MAX_PAGE);
  if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1) return null;
  return Math.min(asked, MAX_PAGE);
}

// ------------------------------------------------------------ rows → answers

export type MentionRow = {
  seq: number;
  id: string;
  token_id: string;
  thread: string;
  line_id: string;
  text: string;
  author: string;
  created_at: number;
};

/** The tool's item: the line, as a person wrote it. No thread, no history. */
export const toolItem = (r: MentionRow) => ({
  id: r.id,
  lineId: r.line_id,
  text: r.text,
  author: r.author,
  at: new Date(Number(r.created_at)).toISOString(),
});

/** SEP-3415 EventOccurrence: the same payload as the webhook's `data`. */
export const pollEvent = (r: MentionRow) => ({
  eventId: r.id,
  name: "chat.mention",
  timestamp: new Date(Number(r.created_at)).toISOString(),
  data: { id: r.line_id, text: r.text, author: r.author },
});
