import { isSessionTag, isUserId, sessionTag } from "@/lib/dev-eval";
import { isOwner } from "@/lib/owner";

/**
 * Is the owner's sign-in session with this tag still live? Asked by
 * lianki-push's debug hub right before it renews an eval grant bound to it
 * (docs/monitoring.md, "Renewal"), so a sign-out whose notice was lost still
 * stops renewal.
 *
 * Not an HTTP route: the main Worker exports it as the RPC entrypoint
 * `DebugSessions` (worker.ts), reachable only over lianki-push's service
 * binding — nothing on the internet can call it, and no shared secret is
 * needed. Inputs are bounded before any DB work (a user id ≤ 64 characters,
 * a 64-hex tag), and callers are rate-limited all the same.
 *
 * Only the owner's sessions can ever be live; anything else is `false`. D1
 * only: the auth tables are read directly (`session`, `user`).
 */
export type SessionDb = {
  prepare(sql: string): {
    bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> };
  };
};

const SQL =
  "SELECT s.id AS id, s.expiresAt AS expiresAt, u.email AS email FROM session s JOIN user u ON u.id = s.userId WHERE s.userId = ?";

export async function sessionLive(
  db: SessionDb | null | undefined,
  user: unknown,
  tag: unknown,
  opts: { ownerEmails?: string; now?: () => number } = {},
): Promise<boolean> {
  if (!db || !isUserId(user) || !isSessionTag(tag)) return false;
  const { results } = await db
    .prepare(SQL)
    .bind(user)
    .all<{ id: string; expiresAt: string | number; email: string | null }>();
  const t = (opts.now ?? Date.now)();
  for (const s of results) {
    if (!isOwner(s.email, opts.ownerEmails)) return false;
    if (new Date(s.expiresAt).getTime() > t && (await sessionTag(s.id)) === tag) return true;
  }
  return false;
}

/**
 * A fixed-window limit, per isolate: at most `max` calls per `windowMs`.
 * Even the only caller (the hub, itself limited per grant) cannot make the
 * main Worker do unbounded DB work.
 */
export function rateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  let start = -Infinity;
  let n = 0;
  return () => {
    const t = now();
    if (t - start >= windowMs) {
      start = t;
      n = 0;
    }
    return ++n <= max;
  };
}
