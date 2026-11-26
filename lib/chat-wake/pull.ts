/**
 * Chat wake, the pull adapter (docs/chat-wake.md, "Pull"): any MCP client
 * reads its own token's mentions. Two shapes over the same rows:
 *
 * - `chat/mentions` {cursor?, limit?}: the MCP tool lianki_chat_mentions_since
 *   (packages/lianki-cli/mcp-tools.mjs), for a Gemini scheduled action, a
 *   local agent, or the planned `ay` listener. No cursor: the last
 *   chat.wakePullTtlMin.
 * - `events/poll` {name: "chat.mention", arguments: {}, cursor, maxAgeMs?,
 *   maxEvents?}: SEP-3415 poll delivery. A null cursor bootstraps: nothing
 *   returned, a cursor for "from now".
 *
 * Both answer only `chat_mention` rows of the caller's own token in its own
 * thread. Gated by mcp.events (the core, checked by the caller) and
 * chat.wake.pull, both fail closed. The pull adapter's `wake` sends nothing:
 * the row the core kept is the delivery.
 */
import { hit, type ThrottleDb } from "@/lib/security/throttle";
import { MENTION_EVENT, type Refusal } from "@/lib/mcp-events/rules";
import { capGap, limitsOf, prune, type WakeDeps } from "./core";
import {
  type Cursor,
  type MentionRow,
  type WakeAdapter,
  type WakeLimits,
  WAKE_PULL_FLAG,
  cursorTruncated,
  decodeCursor,
  encodeCursor,
  pageSize,
  pollEvent,
  toolItem,
} from "./rules";

/** The internal method the tool calls, and the SEP-3415 one. */
export const MENTIONS_METHOD = "chat/mentions";
export const POLL_METHOD = "events/poll";
export const PULL_METHODS = [MENTIONS_METHOD, POLL_METHOD];

export const pullAdapter: WakeAdapter<WakeDeps> = {
  id: WAKE_PULL_FLAG,
  mode: "pull",
  enabled: async (d) => (d.pullOn ? d.pullOn() : false),
  // Nothing to send: the client reads the row with its own token.
  wake: async () => {},
};

type Answer = { result: unknown } | { error: Refusal };
const fail = (code: number, message: string, data?: Record<string, unknown>): Answer => ({
  error: { code, message, ...(data ? { data } : {}) },
});

type Who = { tokenHash: string; thread: string };

/** Rows of this token in its thread after `seq`, oldest first, at most `n`. */
/**
 * Rows of this token in its thread strictly after `from` in (created_at, seq)
 * order, not older than `since`, at most `n`. The position is a value, not a
 * row, so rows deleted before it (retention, the cap) never shift a page.
 */
async function after(
  d: WakeDeps,
  who: Who,
  from: Cursor,
  since: number,
  n: number,
): Promise<MentionRow[]> {
  const { results } = await d.db
    .prepare(
      `SELECT * FROM chat_mention
       WHERE token_id = ?1 AND thread = ?2 AND created_at >= ?3
         AND (created_at > ?4 OR (created_at = ?4 AND seq > ?5))
       ORDER BY created_at, seq LIMIT ?6`,
    )
    .bind(who.tokenHash, who.thread, since, from.at, from.seq, n)
    .all<MentionRow>();
  return results;
}

/** Is the row a cursor names still there (for `truncated`)? */
async function rowExists(d: WakeDeps, who: Who, c: Cursor): Promise<boolean> {
  if (c.seq <= 0) return false;
  const r = await d.db
    .prepare("SELECT 1 AS ok FROM chat_mention WHERE token_id = ? AND seq = ? AND created_at = ?")
    .bind(who.tokenHash, c.seq, c.at)
    .first<{ ok: number }>();
  return r?.ok === 1;
}

/** The position after everything this token has now: its newest row, or "now". */
async function latest(d: WakeDeps, who: Who): Promise<Cursor> {
  const r = await d.db
    .prepare(
      "SELECT created_at, seq FROM chat_mention WHERE token_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1",
    )
    .bind(who.tokenHash)
    .first<{ created_at: number; seq: number }>();
  return r ? { at: Number(r.created_at), seq: Number(r.seq) } : { at: d.now(), seq: 0 };
}

/**
 * One page after `from`: rows, whether more wait, the cursor after them, and
 * whether rows after `from` may be gone (its row deleted). An empty page keeps
 * `from` while it is sound, else moves to the newest row, so `truncated` is
 * reported once, not on every later call.
 */
async function page(d: WakeDeps, who: Who, from: Cursor, since: number, n: number, l: WakeLimits) {
  const truncated = cursorTruncated(
    from,
    await rowExists(d, who, from),
    d.now(),
    l,
    await capGap(d.db, who.tokenHash),
  );
  const rows = await after(d, who, from, since, n + 1);
  const hasMore = rows.length > n;
  const shown = rows.slice(0, n);
  const last = shown[shown.length - 1];
  const next: Cursor = last
    ? { at: Number(last.created_at), seq: Number(last.seq) }
    : truncated
      ? await latest(d, who)
      : from;
  return { shown, hasMore, truncated, cursor: encodeCursor(next) };
}

/**
 * One pull call for a live principal (lib/chat-wake/principal.ts), after the
 * caller checked mcp.events. Off (chat.wake.pull), or not a pull method:
 * "Method not found", as on a server without it.
 */
export async function pullRpc(
  d: WakeDeps,
  who: Who,
  method: string,
  raw: unknown,
): Promise<Answer> {
  if (!PULL_METHODS.includes(method)) return fail(-32601, "Method not found");
  if (!(await pullAdapter.enabled(d).catch(() => false))) return fail(-32601, "Method not found");
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const l: WakeLimits = await limitsOf(d);
  const now = d.now();
  const rate = await hit(
    d.db as unknown as ThrottleDb,
    `chat-wake:${who.tokenHash.slice(0, 16)}:pull`,
    { max: l.pullPerMinute, windowMs: 60_000 },
    now,
  );
  if (!rate.allowed)
    return fail(-32005, "Too many mention checks; try again later", {
      retryAfterMs: rate.retryAfterMs,
    });
  await prune(d.db, who.tokenHash, now, l);

  if (method === MENTIONS_METHOD) {
    const n = pageSize(p.limit, l);
    if (n === null) return fail(-32602, "limit: a whole number from 1");
    if (p.cursor === undefined || p.cursor === null) {
      const out = await page(d, who, { at: 0, seq: 0 }, now - l.pullTtlMs, n, l);
      // Nothing in the window: the cursor still starts after what exists now.
      const cursor = out.shown.length ? out.cursor : encodeCursor(await latest(d, who));
      return {
        result: {
          mentions: out.shown.map(toolItem),
          cursor,
          hasMore: out.hasMore,
          truncated: false,
        },
      };
    }
    const c = decodeCursor(p.cursor);
    if (!c) return fail(-32602, "cursor: pass back the cursor a previous call returned");
    const out = await page(d, who, c, 0, n, l);
    return {
      result: {
        mentions: out.shown.map(toolItem),
        cursor: out.cursor,
        hasMore: out.hasMore,
        truncated: out.truncated,
      },
    };
  }

  // events/poll (SEP-3415)
  if (p.name !== MENTION_EVENT) return fail(-32602, "Unknown event");
  const a = p.arguments;
  if (
    a !== undefined &&
    a !== null &&
    (typeof a !== "object" || Array.isArray(a) || Object.keys(a).length)
  )
    return fail(-32602, "chat.mention takes no arguments");
  const n = pageSize(p.maxEvents, l);
  if (n === null) return fail(-32602, "maxEvents: a whole number from 1");
  const base = { resultType: "complete", nextPollMs: l.nextPollMs };
  if (p.cursor === undefined || p.cursor === null)
    // No subscribe step: a null cursor bootstraps "from now".
    return {
      result: {
        ...base,
        events: [],
        cursor: encodeCursor(await latest(d, who)),
        truncated: false,
        hasMore: false,
      },
    };
  const c = decodeCursor(p.cursor);
  if (!c) return fail(-32602, "cursor: pass back the cursor a previous poll returned");
  const m = p.maxAgeMs;
  if (m !== undefined && (typeof m !== "number" || !Number.isFinite(m) || m <= 0))
    return fail(-32602, "maxAgeMs: a positive number");
  // Whichever is later: the cursor, or now − maxAgeMs (never past our own window).
  const floor = typeof m === "number" ? now - Math.min(m, l.pullTtlMs) : 0;
  const out = await page(d, who, c, floor, n, l);
  return {
    result: {
      ...base,
      events: out.shown.map(pollEvent),
      cursor: out.cursor,
      truncated: out.truncated,
      hasMore: out.hasMore,
    },
  };
}
