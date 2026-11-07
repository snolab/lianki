/**
 * /api/chat/history (docs/chat-history.md): the signed-in user's own chat
 * history. GET lists (search, lane, cursor); DELETE removes one line {id} or
 * a day {from, to} (the user's local day, as epoch ms). Everything is by the
 * caller's own account id: there is no parameter naming an account, and a
 * line of another account answers 404 as one that does not exist.
 *
 * Who may read: the session's user, or a `lianki chat` API token holding
 * `chat:read` (lib/api-tokens.ts checkToken; the route's `reader`), which
 * reads that token's own account. Deleting stays with the session alone.
 */
import {
  CHAT_LOG_MAX_QUERY,
  type ChatLogDb,
  LANE_FILTERS,
  type LaneFilter,
  backfilled,
  deleteLine,
  deleteRange,
  listHistory,
} from "./chat-log";

export type HistoryUser = { id: string; owner: boolean };

export type HistoryDeps = {
  /** The session's user (a deleting caller), or null. */
  who: () => Promise<HistoryUser | null>;
  /** Who may read: the session's user, or a chat:read token's account. Defaults to `who`. */
  reader?: (req: Request) => Promise<HistoryUser | null>;
  db: () => ChatLogDb | null;
  /** Asks lianki-push to copy the owner thread's stored history in, once (null: no binding). */
  backfill?: () => Promise<unknown>;
};

/** At most one day and an hour (a day with a clock change), for a day's delete. */
export const MAX_DAY_MS = 25 * 3600_000;

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });

export async function getHistory(req: Request, deps: HistoryDeps): Promise<Response> {
  const user = await (deps.reader ?? deps.who)(req);
  if (!user) return notFound();
  const db = deps.db();
  if (!db) return json({ lines: [], next: null });
  // The owner's first visit copies in what the hub still holds (once per account).
  if (user.owner && deps.backfill && !(await backfilled(db, user.id))) {
    try {
      await deps.backfill();
    } catch (e) {
      console.log(JSON.stringify({ msg: "chat-history.backfill", error: String(e).slice(0, 200) }));
    }
  }
  const u = new URL(req.url);
  const lane = u.searchParams.get("lane");
  const before = u.searchParams.get("before");
  const out = await listHistory(db, user.id, {
    q: (u.searchParams.get("q") ?? "").slice(0, CHAT_LOG_MAX_QUERY),
    lane: (LANE_FILTERS as readonly string[]).includes(lane ?? "")
      ? (lane as LaneFilter)
      : undefined,
    before: before !== null && /^\d{1,16}$/.test(before) ? Number(before) : undefined,
    beforeId: u.searchParams.get("beforeId") ?? undefined,
  });
  return json(out);
}

export async function deleteHistory(req: Request, deps: HistoryDeps): Promise<Response> {
  const user = await deps.who();
  if (!user) return notFound();
  const db = deps.db();
  if (!db) return notFound();
  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    from?: unknown;
    to?: unknown;
  } | null;
  if (body && typeof body.id === "string" && body.id.length <= 80) {
    return (await deleteLine(db, user.id, body.id)) ? json({ deleted: 1 }) : notFound();
  }
  const from = Number(body?.from);
  const to = Number(body?.to);
  if (
    body &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    to > from &&
    to - from <= MAX_DAY_MS
  ) {
    const n = await deleteRange(db, user.id, from, to);
    return n ? json({ deleted: n }) : notFound();
  }
  return json({ error: "expected {id} or {from, to} (one day at most)" }, 400);
}
