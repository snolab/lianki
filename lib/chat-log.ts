/**
 * The account's chat history in D1 (db/migrations/0057_chat_line.sql;
 * docs/chat-history.md). lianki-push's DebugHub writes each line of a thread
 * as it is kept, over the SESSIONS binding (worker.ts DebugSessions.chatLog);
 * the signed-in user reads and deletes their own at /chat/history
 * (app/api/chat/history).
 *
 * Whose lines: a thread is "owner" (written to every account holding `dev`,
 * lib/permissions.ts) or a user id (that user's Learning Partner thread, written to
 * that account only). Every read and delete is by the session's user id; no
 * request can name another account.
 */
import { holderIds } from "./account-permission";
import { OWNER_THREAD, isUserId } from "./dev-eval";
import {
  CHAT_LOG_MAX_LINES,
  type ChatLogAnswer,
  type ChatLogLine,
  type ChatLogRequest,
  parseChatLogLine,
} from "./chat-log-line";

/** The slice of D1 used here (the real binding, or lib/d1/testDb.ts). */
export type ChatLogStmt = {
  bind(...v: unknown[]): ChatLogStmt;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};
export type ChatLogDb = {
  prepare(sql: string): ChatLogStmt;
  batch(s: ChatLogStmt[]): Promise<unknown>;
};

/** Lines per page of /chat/history. */
export const CHAT_LOG_PAGE = 100;
/** Longest search text. */
export const CHAT_LOG_MAX_QUERY = 200;
/** The filter's choices: the user's own lines, or one lane. */
export const LANE_FILTERS = ["you", "main", "codex", "agy"] as const;
export type LaneFilter = (typeof LANE_FILTERS)[number];

/** A line as the page gets it. */
export type ChatHistoryLine = ChatLogLine & { thread: string };

type Row = {
  id: string;
  thread: string;
  sender: string;
  lane: string | null;
  text: string;
  at_ms: number;
  ask: number;
  answer: string | null;
};
const COLS = "id, thread, sender, lane, text, at_ms, ask, answer";
const lineOf = (r: Row): ChatHistoryLine => ({
  id: r.id,
  thread: r.thread,
  from: r.sender as ChatLogLine["from"],
  lane: (r.lane as ChatLogLine["lane"]) ?? null,
  text: r.text,
  at: Number(r.at_ms),
  ask: Number(r.ask) === 1,
  answer: r.answer,
});

/** The owner thread's accounts: those holding `dev` (the owner chat thread, lib/permissions.ts). */
export const ownerIds = (db: ChatLogDb): Promise<string[]> => holderIds(db, "dev");

/** The accounts a thread's lines belong to: the owners for "owner", else that user. */
export async function accountsOf(db: ChatLogDb, thread: string): Promise<string[]> {
  if (thread === OWNER_THREAD) return ownerIds(db);
  if (!isUserId(thread)) return [];
  // A user's own thread is theirs alone; an owner's pages always use "owner".
  const u = await db
    .prepare(`SELECT id FROM user WHERE id = ?`)
    .bind(thread)
    .first<{ id: string }>();
  return u ? [u.id] : [];
}

const INSERT = `INSERT OR IGNORE INTO chat_line (user_id, ${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const insert = (db: ChatLogDb, user: string, thread: string, l: ChatLogLine) =>
  db
    .prepare(INSERT)
    .bind(user, l.id, thread, l.from, l.lane, l.text, l.at, l.ask ? 1 : 0, l.answer);
const update = (db: ChatLogDb, user: string, l: ChatLogLine) =>
  db
    .prepare(
      `UPDATE chat_line SET text = ?, lane = ?, ask = ?, answer = ? WHERE user_id = ? AND id = ?`,
    )
    .bind(l.text, l.lane, l.ask ? 1 : 0, l.answer, user, l.id);

/**
 * The hub's write (DebugSessions.chatLog). Deny by default: a bad request
 * writes nothing. A deleted line stays deleted: `update` and `split` touch
 * only lines still kept, and a backfill runs once per account.
 */
export async function chatLogOp(
  db: ChatLogDb | undefined,
  raw: unknown,
  opts: { now?: () => number } = {},
): Promise<ChatLogAnswer> {
  if (!db) return { ok: false, error: "no database" };
  const req = raw as Partial<ChatLogRequest> | null;
  if (!req || typeof req !== "object" || typeof req.thread !== "string")
    return { ok: false, error: "bad request" };
  if (!["put", "update", "split", "backfill"].includes(req.op as string))
    return { ok: false, error: "bad op" };
  if (!Array.isArray(req.lines) || req.lines.length > CHAT_LOG_MAX_LINES)
    return { ok: false, error: "bad lines" };
  const lines = req.lines.map(parseChatLogLine).filter((l): l is ChatLogLine => !!l);
  if (req.op === "backfill" && req.thread !== OWNER_THREAD)
    return { ok: false, error: "backfill is for the owner's thread" };
  const users = await accountsOf(db, req.thread);
  if (!users.length) return { ok: true, written: 0 };
  const now = (opts.now ?? Date.now)();
  const stmts: ChatLogStmt[] = [];
  for (const user of users) {
    if (req.op === "put") for (const l of lines) stmts.push(insert(db, user, req.thread, l));
    else if (req.op === "update") for (const l of lines) stmts.push(update(db, user, l));
    else if (req.op === "split") {
      const id = (req as { id?: unknown }).id;
      if (typeof id !== "string") return { ok: false, error: "bad split" };
      const kept = await db
        .prepare(`SELECT 1 AS k FROM chat_line WHERE user_id = ? AND id = ?`)
        .bind(user, id)
        .first<{ k: number }>();
      if (!kept) continue;
      for (const l of lines)
        stmts.push(l.id === id ? update(db, user, l) : insert(db, user, req.thread, l));
    } else {
      const done = await db
        .prepare(`SELECT at_ms FROM chat_line_backfill WHERE user_id = ?`)
        .bind(user)
        .first<{ at_ms: number }>();
      if (done) continue;
      for (const l of lines) stmts.push(insert(db, user, req.thread, l));
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO chat_line_backfill (user_id, thread, lines, at_ms) VALUES (?, ?, ?, ?)`,
          )
          .bind(user, req.thread, lines.length, now),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, written: stmts.length };
}

/** Has this account's backfill run? */
export async function backfilled(db: ChatLogDb, user: string): Promise<boolean> {
  return !!(await db
    .prepare(`SELECT 1 AS k FROM chat_line_backfill WHERE user_id = ?`)
    .bind(user)
    .first<{ k: number }>());
}

/** Escapes LIKE's wildcards: the search is for the text as typed. */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export type HistoryQuery = {
  /** Search text, matched anywhere in a line, case-insensitive for ASCII. */
  q?: string;
  lane?: LaneFilter;
  /** Lines before this time (the previous page's last `at`) … */
  before?: number;
  /** … and, at that same time, ids before this one. */
  beforeId?: string;
  limit?: number;
};

/** One page of the user's own history, newest first, and the cursor for the next. */
export async function listHistory(
  db: ChatLogDb,
  user: string,
  q: HistoryQuery = {},
): Promise<{ lines: ChatHistoryLine[]; next: { before: number; beforeId: string } | null }> {
  const where = ["user_id = ?"];
  const args: unknown[] = [user];
  const text = q.q?.trim().slice(0, CHAT_LOG_MAX_QUERY);
  if (text) {
    where.push(`text LIKE ? ESCAPE '\\'`);
    args.push(likeOf(text));
  }
  if (q.lane === "you") where.push(`sender != 'agent'`);
  else if (q.lane) {
    where.push(`sender = 'agent' AND lane = ?`);
    args.push(q.lane);
  }
  if (q.before !== undefined && Number.isFinite(q.before)) {
    where.push(`(at_ms < ? OR (at_ms = ? AND id < ?))`);
    args.push(q.before, q.before, q.beforeId ?? "");
  }
  const limit = Math.min(Math.max(q.limit ?? CHAT_LOG_PAGE, 1), CHAT_LOG_PAGE);
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM chat_line WHERE ${where.join(" AND ")} ORDER BY at_ms DESC, id DESC LIMIT ?`,
    )
    .bind(...args, limit + 1)
    .all<Row>();
  const lines = results.slice(0, limit).map(lineOf);
  const last = lines.at(-1);
  return {
    lines,
    next: results.length > limit && last ? { before: last.at, beforeId: last.id } : null,
  };
}

/** Deletes one of the user's own lines; false when there is none by that id (another account's is none). */
export async function deleteLine(db: ChatLogDb, user: string, id: string): Promise<boolean> {
  const hit = await db
    .prepare(`SELECT 1 AS k FROM chat_line WHERE user_id = ? AND id = ?`)
    .bind(user, id)
    .first<{ k: number }>();
  if (!hit) return false;
  await db.prepare(`DELETE FROM chat_line WHERE user_id = ? AND id = ?`).bind(user, id).run();
  return true;
}

/** Deletes the user's own lines in [from, to) (a day on their clock); how many went. */
export async function deleteRange(
  db: ChatLogDb,
  user: string,
  from: number,
  to: number,
): Promise<number> {
  const n = await db
    .prepare(`SELECT COUNT(*) AS n FROM chat_line WHERE user_id = ? AND at_ms >= ? AND at_ms < ?`)
    .bind(user, from, to)
    .first<{ n: number }>();
  if (!n?.n) return 0;
  await db
    .prepare(`DELETE FROM chat_line WHERE user_id = ? AND at_ms >= ? AND at_ms < ?`)
    .bind(user, from, to)
    .run();
  return Number(n.n);
}
