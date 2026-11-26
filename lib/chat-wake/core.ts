/**
 * Chat wake, the core (docs/chat-wake.md): the hub kept new lines of a thread
 * (DebugSessions.chatLog "put", worker.ts). For every live token of that
 * thread a person's line names (`@<token name>`), one `chat_mention` row is
 * kept (D1, migration 0086), and the token's events go to every enabled wake
 * adapter through one `wake()`.
 *
 * Deny by default: the flag mcp.events (the core), the token live with
 * chat:read, its account a `dev` holder, the line in exactly that token's own
 * thread, and only a person's line (the loop guard, lib/mcp-events/rules.ts).
 * Each adapter has its own flag on top. Never throws (runs in waitUntil).
 */
import type { D1Like } from "@/lib/d1/types";
import { DISPATCH_THREAD, isUserId } from "@/lib/dev-eval";
import { holdsSql } from "@/lib/account-permission";
import { hit, type ThrottleDb } from "@/lib/security/throttle";
import { defaultConfig } from "@/lib/config";
import {
  MAX_MENTION_TEXT,
  type MentionLine,
  anyCandidate,
  mayTrigger,
  mentions,
} from "@/lib/mcp-events/rules";
import { principal } from "./principal";
import {
  type WakeAdapter,
  type WakeEvent,
  type WakeLimits,
  type WakeReport,
  type WakeTarget,
  dedupe,
  mentionId,
  wakeLimits,
} from "./rules";

export type WakeDeps = {
  db: D1Like;
  /** The core's flag, mcp.events (fail closed). */
  flagOn: () => Promise<boolean>;
  /** chat.wake.pull (fail closed). Absent: off. */
  pullOn?: () => Promise<boolean>;
  /** Absent: the shipped defaults (lib/config.ts chat.wake*). */
  wakeLimits?: () => Promise<WakeLimits>;
  now: () => number;
};

export const limitsOf = (d: WakeDeps) =>
  d.wakeLimits ? d.wakeLimits() : Promise.resolve(wakeLimits(defaultConfig()));

/** What the hub wrote (lib/chat-log-line.ts ChatLogRequest), as far as this reads it. */
type PutRequest = { op?: unknown; thread?: unknown; lines?: unknown };

export function linesOf(req: PutRequest): MentionLine[] {
  if (!Array.isArray(req.lines)) return [];
  const out: MentionLine[] = [];
  for (const raw of req.lines.slice(0, 250)) {
    const l = raw as Record<string, unknown>;
    if (
      typeof l?.id === "string" &&
      typeof l.text === "string" &&
      (l.from === "owner" || l.from === "friend" || l.from === "agent")
    )
      out.push({ id: l.id, from: l.from, text: l.text });
  }
  return out;
}

/**
 * The tokens of the account(s) whose thread this is, with their names: the
 * `dev` holders for the owner thread, else that user. At most `max`, newest
 * first. Only names are compared here; each one named is checked live after.
 */
async function accountTokens(
  db: D1Like,
  thread: string,
  max: number,
): Promise<{ h: string; name: string }[]> {
  const base = `SELECT t.token_hash AS h, t.name AS name FROM api_tokens t
    JOIN user u ON u.email = t.email AND (t.user_id IS NULL OR u.id = t.user_id)`;
  if (thread === DISPATCH_THREAD) {
    const { results } = await db
      .prepare(`${base} WHERE ${holdsSql("u.id", "dev")} ORDER BY t.created_at DESC LIMIT ?`)
      .bind(max)
      .all<{ h: string; name: string }>();
    return results;
  }
  if (!isUserId(thread)) return [];
  const { results } = await db
    .prepare(`${base} WHERE u.id = ? ORDER BY t.created_at DESC LIMIT ?`)
    .bind(thread, max)
    .all<{ h: string; name: string }>();
  return results;
}

/**
 * Keep one row per token and line (the event id is its key). A line put again
 * is the same row (`fresh: false`). New rows are capped per token per minute
 * (chat.wakePerMinute); over the cap nothing is kept. Old rows past retention
 * go at the same time.
 */
async function record(
  d: WakeDeps,
  t: WakeTarget,
  line: MentionLine & { from: "owner" | "friend" },
  l: WakeLimits,
  report: WakeReport,
): Promise<WakeEvent> {
  const id = await mentionId(t.tokenHash, line.id);
  const now = d.now();
  const text = line.text.slice(0, MAX_MENTION_TEXT);
  const ev: WakeEvent = {
    id,
    tokenHash: t.tokenHash,
    thread: t.thread,
    lineId: line.id,
    text,
    author: line.from,
    createdAt: now,
    fresh: false,
  };
  const known = await d.db
    .prepare("SELECT created_at FROM chat_mention WHERE id = ?")
    .bind(id)
    .first<{ created_at: number }>();
  if (known) return { ...ev, createdAt: Number(known.created_at) };
  const rate = await hit(
    d.db as unknown as ThrottleDb,
    `chat-wake:${t.tokenHash.slice(0, 16)}:record`,
    { max: l.perMinute, windowMs: 60_000 },
    now,
  );
  if (!rate.allowed) return ev;
  const row = await d.db
    .prepare(
      `INSERT INTO chat_mention (id, token_id, thread, line_id, text, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING seq`,
    )
    .bind(id, t.tokenHash, t.thread, line.id, text, line.from, now)
    .first<{ seq: number }>();
  if (row) report.recorded++;
  return { ...ev, fresh: !!row };
}

/** Retention: a token's rows older than chat.wakeRetentionDays. */
export async function prune(db: D1Like, tokenHash: string, now: number, l: WakeLimits) {
  await db
    .prepare("DELETE FROM chat_mention WHERE token_id = ? AND created_at < ?")
    .bind(tokenHash, now - l.retentionMs)
    .run();
}

/**
 * One fan-out: the token's events, deduped on their id, to every enabled
 * adapter. One adapter failing never stops the others.
 */
export async function wake<D extends WakeDeps>(
  d: D,
  target: WakeTarget,
  events: WakeEvent[],
  adapters: WakeAdapter<D>[],
  report: WakeReport,
): Promise<void> {
  const once = dedupe(events);
  if (!once.length) return;
  for (const a of adapters) {
    try {
      await a.wake(d, target, once, report);
    } catch (e) {
      console.error(`[chat-wake] ${a.id}:`, String(e).slice(0, 200));
    }
  }
}

const enabledOf = async <D>(d: D, adapters: WakeAdapter<D>[]) => {
  const out: WakeAdapter<D>[] = [];
  for (const a of adapters) if (await a.enabled(d).catch(() => false)) out.push(a);
  return out;
};

/**
 * New lines of a thread: record and wake. `adapters` are the wake adapters
 * (lib/mcp-events/server.ts passes the ChatGPT webhook and the pull adapter).
 */
export async function wakeOnPut<D extends WakeDeps>(
  d: D,
  raw: unknown,
  adapters: WakeAdapter<D>[],
): Promise<WakeReport> {
  const report: WakeReport = { delivered: 0, skipped: 0, dropped: 0, recorded: 0 };
  try {
    const req = (raw && typeof raw === "object" ? raw : {}) as PutRequest;
    if (req.op !== "put" || typeof req.thread !== "string") return report;
    const thread = req.thread;
    const lines = linesOf(req);
    // No person's line holds an @: nothing read from D1 at all.
    if (!anyCandidate(lines)) return report;
    if (!(await d.flagOn())) return report;
    const live = await enabledOf(d, adapters);
    const now = d.now();
    const people = lines.filter(mayTrigger);
    const l = await limitsOf(d);
    // The candidates: tokens a push adapter holds a route for in this thread,
    // and the thread's own tokens whose name a person's line names.
    const candidates: string[] = [];
    const add = (h: string) => {
      if (!candidates.includes(h)) candidates.push(h);
    };
    for (const a of live) if (a.tokensIn) for (const h of await a.tokensIn(d, thread, now)) add(h);
    for (const t of await accountTokens(d.db, thread, l.maxTokens))
      if (people.some((p) => mentions(p.text, t.name))) add(t.h);
    for (const h of candidates) {
      const p = await principal(d, h, true);
      if (!p.ok || p.thread !== thread) {
        // Revoked, expired, out of scope, audience lost, or not this thread.
        const why = p.ok ? "thread" : p.why;
        for (const a of live) await a.notLive?.(d, h, thread, why, report);
        continue;
      }
      const target: WakeTarget = {
        tokenHash: p.tokenHash,
        userId: p.userId,
        name: p.name,
        thread: p.thread,
      };
      const events: WakeEvent[] = [];
      for (const line of people)
        if (mentions(line.text, p.name)) events.push(await record(d, target, line, l, report));
      if (!events.length) continue;
      await prune(d.db, p.tokenHash, now, l);
      await wake(d, target, events, live, report);
    }
  } catch (e) {
    console.error("[chat-wake] put:", String(e).slice(0, 200));
  }
  return report;
}
