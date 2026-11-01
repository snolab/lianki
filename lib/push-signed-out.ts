import { getCloudflareContext } from "@opennextjs/cloudflare";
import { EVAL_CHAIN_MS, sessionTag } from "@/lib/dev-eval";

/**
 * A sign-in session was deleted (sign-out): tell lianki-push's DebugHub, over
 * the PUSH service binding, so every eval grant whose auto-renewal is bound to
 * that session stops renewing at once, and the owner pages that carried the
 * session drop it (docs/monitoring.md, "Renewal"). Only the session's tag (a
 * hash of its id) is sent.
 *
 * Durable until acknowledged (a 2xx from the hub). A notice that does not get
 * through is written to the D1 outbox (`debug_signout_outbox`) before the
 * sign-out returns, retried after the response with a short backoff, and
 * after that when the owner's debug page connects (flushSignedOutSoon, at
 * most once a minute per isolate, ≤ 20 rows), with an exponential backoff, for
 * as long as a renewal chain could still be bound to it (EVAL_CHAIN_MS). No
 * timers that outlive a request, no polling.
 *
 * Even with no notice at all the hub renews nothing for a deleted session: it
 * asks the main Worker before every renewal (lib/debug-session.ts). This is
 * the "at once" half. Never throws: a sign-out must not fail on it. Off the
 * Worker (dev, QA) there is no binding: nothing happens.
 */
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
type Stmt = {
  bind(...v: unknown[]): Stmt;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
};
export type OutboxDb = { prepare(sql: string): Stmt };
export type NoticeDeps = {
  push: Fetcher | null;
  db: OutboxDb | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Keep a promise running after the response (ctx.waitUntil). */
  later: (p: Promise<unknown>) => void;
};

const URL_SIGNED_OUT = "https://lianki-push/internal/signed-out";
/** Retries after the response, within the same request's waitUntil. */
export const RETRY_MS = [1_000, 4_000, 15_000];
/** The outbox's backoff: 1 min, 2 min, 4 min, … at most an hour. */
export const outboxBackoff = (tries: number) => Math.min(60_000 * 2 ** tries, 60 * 60_000);

function cf() {
  try {
    return getCloudflareContext();
  } catch {
    return null;
  }
}

/** The real bindings: PUSH, D1 when it is the backend, the request's waitUntil. */
export function noticeDeps(): NoticeDeps {
  const c = cf();
  const env = (c?.env ?? {}) as { PUSH?: Fetcher; DB?: OutboxDb };
  return {
    push: env.PUSH ?? null,
    db: process.env.DB_BACKEND === "d1" ? (env.DB ?? null) : null,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    later: (p) => {
      if (c?.ctx) c.ctx.waitUntil(p);
      else void p;
    },
  };
}

/** One delivery: true only on the hub's 2xx. */
async function deliver(push: Fetcher, tag: string): Promise<boolean> {
  try {
    const res = await push.fetch(URL_SIGNED_OUT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: tag }),
    });
    if (!res.ok) console.error(`[debug] signed-out notice: lianki-push ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error("[debug] signed-out notice:", e);
    return false;
  }
}

const sql = {
  add: "INSERT INTO debug_signout_outbox (tag, at_ms, tries, next_ms) VALUES (?, ?, 0, ?) ON CONFLICT(tag) DO NOTHING",
  due: "SELECT tag, at_ms, tries FROM debug_signout_outbox WHERE next_ms <= ? ORDER BY next_ms LIMIT 20",
  done: "DELETE FROM debug_signout_outbox WHERE tag = ?",
  later: "UPDATE debug_signout_outbox SET tries = ?, next_ms = ? WHERE tag = ?",
};

async function tryDb(f: () => Promise<unknown>) {
  try {
    await f();
  } catch (e) {
    console.error("[debug] signed-out outbox:", e);
  }
}

export async function notifySignedOut(sessionId: string, d: NoticeDeps = noticeDeps()) {
  if (!d.push || !sessionId) return;
  const push = d.push;
  const tag = await sessionTag(sessionId);
  if (await deliver(push, tag)) return;
  // Kept before the sign-out returns: it outlives this request.
  const t = d.now();
  await tryDb(async () =>
    d.db
      ?.prepare(sql.add)
      .bind(tag, t, t + outboxBackoff(0))
      .run(),
  );
  d.later(
    (async () => {
      for (const ms of RETRY_MS) {
        await d.sleep(ms);
        if (await deliver(push, tag)) {
          await tryDb(async () => d.db?.prepare(sql.done).bind(tag).run());
          return;
        }
      }
    })(),
  );
}

/** Retry the outbox's due notices; drop them once acknowledged, or once no chain could use them. */
export async function flushSignedOut(d: NoticeDeps = noticeDeps()) {
  const { push, db } = d;
  if (!push || !db) return;
  const t = d.now();
  await tryDb(async () => {
    const { results } = await db
      .prepare(sql.due)
      .bind(t)
      .all<{ tag: string; at_ms: number; tries: number }>();
    for (const row of results) {
      if (t - row.at_ms > EVAL_CHAIN_MS || (await deliver(push, row.tag)))
        await db.prepare(sql.done).bind(row.tag).run();
      else
        await db
          .prepare(sql.later)
          .bind(row.tries + 1, t + outboxBackoff(row.tries + 1), row.tag)
          .run();
    }
  });
}

/** The least time between two flushes in one isolate. */
export const FLUSH_MIN_MS = 60_000;
let lastFlush = -Infinity;

/**
 * flushSignedOut after the response, on an event that happens anyway (the
 * owner's debug page connecting: no timer of its own), at most once per
 * FLUSH_MIN_MS per isolate. True when one was started.
 */
export function flushSignedOutSoon(d: NoticeDeps = noticeDeps()): boolean {
  if (!d.push || !d.db) return false;
  const t = d.now();
  if (t - lastFlush < FLUSH_MIN_MS) return false;
  lastFlush = t;
  d.later(flushSignedOut(d));
  return true;
}
