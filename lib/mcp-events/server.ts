/**
 * MCP Events, the D1 and network part (docs/mcp-events.md;
 * db/migrations/0085_mcp_events.sql). Two entry points:
 *
 * - `eventsRpc`: events/probe, events/list, events/subscribe and
 *   events/unsubscribe for one API token, from POST /api/mcp-events (which
 *   lianki-mcp forwards to with the caller's own Bearer token).
 * - `mentionEvents`: the hub kept new lines of a thread (DebugSessions.chatLog
 *   "put", worker.ts); a person's line naming a subscribed token wakes it.
 *
 * Deny by default: the flag mcp.events, the token live with chat:read, its
 * account a `dev` holder (the flag's owner audience; lib/permissions.ts), and
 * the line in exactly that token's own thread. Every I/O is injected, so
 * unit/mcp-events.test.ts runs it on bun:sqlite and a fake fetch.
 */
import { checkToken } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { threadFor } from "@/lib/dev-eval";
import { userHolds } from "@/lib/account-permission";
import { hit, type ThrottleDb } from "@/lib/security/throttle";
import { seal, sealKey, unseal } from "@/lib/connections/crypto";
import {
  CALLBACK_ENDPOINT_ERROR,
  EVENTS_SCOPE,
  EVENT_DEFINITIONS,
  MAX_EVENT_BODY,
  MENTION_EVENT,
  type Attempt,
  type EventsLimits,
  type MentionLine,
  type Refusal,
  anyCandidate,
  backoffMs,
  b64encode,
  eventId,
  grantedTtl,
  mayTrigger,
  mentionData,
  mentions,
  outcome,
  parseSubscribe,
  refreshAt,
  sameString,
  signatures,
  signingKey,
  subscriptionId,
} from "./rules";

export type EventsDb = D1Like;

export type EventsDeps = {
  db: EventsDb;
  flagOn: () => Promise<boolean>;
  limits: () => Promise<EventsLimits>;
  /** AUTH_SECRET: the signing secrets are sealed with a key derived from it. */
  sealSecret: string | undefined;
  /** The network: a callback POST. Never follows a redirect (`redirect: "manual"`). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

type Row = {
  id: string;
  token_hash: string;
  user_id: string;
  thread: string;
  name: string;
  arguments: string;
  url: string;
  secret_sealed: string;
  prev_secret_sealed: string | null;
  prev_until_ms: number | null;
  expires_at_ms: number;
  verified_at_ms: number;
};

const aad = (id: string, tokenHash: string) => `mcp-events\0${id}\0${tokenHash}`;

/** The live token, its account and its own thread, when it may use events at all. */
async function principal(
  d: EventsDeps,
  cred: string,
  byHash: boolean,
): Promise<
  | { ok: true; tokenHash: string; userId: string; name: string; thread: string }
  | { ok: false; why: "auth" | "scope" | "audience" }
> {
  const c = await checkToken(d.db, cred, EVENTS_SCOPE, d.now(), { byHash });
  if (!c.ok) return { ok: false, why: c.reason === "scope" ? "scope" : "auth" };
  // The flag's audience is the owner: a `dev` holder, read live (no cache).
  const dispatch = await userHolds(d.db as never, c.user.id, "dev");
  if (!dispatch) return { ok: false, why: "audience" };
  const thread = threadFor({ userId: c.user.id, dispatch });
  if (!thread) return { ok: false, why: "audience" };
  return { ok: true, tokenHash: c.id, userId: c.user.id, name: c.name, thread };
}

// ------------------------------------------------------------ the RPC

export type RpcAnswer =
  | { status: 200; body: { result: unknown } | { error: Refusal } }
  | { status: 401; body: { error: Refusal } };

const err = (code: number, message: string, data?: Record<string, unknown>): RpcAnswer => ({
  status: 200,
  body: { error: { code, message, ...(data ? { data } : {}) } },
});
const ok = (result: unknown): RpcAnswer => ({ status: 200, body: { result } });

/**
 * One events/* call for `token` (the secret, from the caller's own Bearer
 * header). While the flag is off, or for an account outside its audience,
 * events/probe says `{on:false}` and every other method is "not found", as on
 * a server without events.
 */
export async function eventsRpc(d: EventsDeps, token: string, raw: unknown): Promise<RpcAnswer> {
  const r = (raw && typeof raw === "object" ? raw : {}) as { method?: unknown; params?: unknown };
  const method = typeof r.method === "string" ? r.method : "";
  if (!["events/probe", "events/list", "events/subscribe", "events/unsubscribe"].includes(method))
    return err(-32601, "Method not found");
  const p = await principal(d, token, false);
  if (!p.ok && p.why === "auth")
    return {
      status: 401,
      body: { error: { code: -32001, message: "Lianki refused the token" } },
    };
  const on = p.ok && (await d.flagOn());
  if (method === "events/probe") return ok({ on });
  if (!p.ok && p.why === "scope")
    return err(-32003, `Events need the ${EVENTS_SCOPE} permission on this token`, {
      needScope: EVENTS_SCOPE,
    });
  if (!on || !p.ok) return err(-32601, "Method not found");
  if (method === "events/list") return ok({ events: EVENT_DEFINITIONS });
  if (method === "events/unsubscribe") {
    const parsed = parseSubscribe(r.params, false);
    if (!parsed.ok) return { status: 200, body: { error: parsed.refusal } };
    const id = await subscriptionId(p.tokenHash, parsed.req.url, parsed.req.name, parsed.req.args);
    await d.db
      .prepare("DELETE FROM mcp_event_subscription WHERE id = ? AND token_hash = ?")
      .bind(id, p.tokenHash)
      .run();
    return ok({});
  }
  return subscribe(d, p, r.params);
}

async function subscribe(
  d: EventsDeps,
  p: { tokenHash: string; userId: string; thread: string },
  params: unknown,
): Promise<RpcAnswer> {
  const parsed = parseSubscribe(params, true);
  if (!parsed.ok) return { status: 200, body: { error: parsed.refusal } };
  const q = parsed.req;
  const l = await d.limits();
  const now = d.now();
  const rate = await hit(
    d.db as unknown as ThrottleDb,
    `mcp-events:${p.tokenHash.slice(0, 16)}:subscribe`,
    { max: l.subscribePerHour, windowMs: 3_600_000 },
    now,
  );
  if (!rate.allowed)
    return err(-32005, "Too many subscribe calls; try again later", {
      retryAfterMs: rate.retryAfterMs,
    });
  if (!d.sealSecret || d.sealSecret.length < 32)
    return err(-32603, "Events are not available on this server");
  const id = await subscriptionId(p.tokenHash, q.url, q.name, q.args);
  const existing = await d.db
    .prepare("SELECT * FROM mcp_event_subscription WHERE id = ?")
    .bind(id)
    .first<Row>();
  if (!existing) {
    const n = await d.db
      .prepare(
        "SELECT COUNT(*) AS n FROM mcp_event_subscription WHERE token_hash = ? AND expires_at_ms > ?",
      )
      .bind(p.tokenHash, now)
      .first<{ n: number }>();
    if (Number(n?.n ?? 0) >= l.maxPerToken)
      return err(-32005, "This token has as many subscriptions as it may hold");
  }
  // The callback proves it holds the secret and wants these events. Success is
  // cached per token and URL for a while (any of its subscriptions).
  const verified = await d.db
    .prepare(
      "SELECT MAX(verified_at_ms) AS at FROM mcp_event_subscription WHERE token_hash = ? AND url = ?",
    )
    .bind(p.tokenHash, q.url)
    .first<{ at: number | null }>();
  const fresh =
    existing?.secret_sealed &&
    verified?.at &&
    now - Number(verified.at) < l.verifyCacheMs &&
    (await openSecret(d, existing, existing.secret_sealed)) === q.secret;
  let verifiedAt = Number(verified?.at ?? 0);
  if (!fresh) {
    const v = await verifyCallback(d, id, q.url, q.key, l);
    if (v !== "ok")
      return err(CALLBACK_ENDPOINT_ERROR, "The callback endpoint could not be verified", {
        reason: v,
      });
    verifiedAt = now;
  }
  const key = await sealKey("mcp-events-secret", d.sealSecret);
  const sealed = await seal(key, q.secret, aad(id, p.tokenHash));
  // A new secret on a known subscription: the old one keeps signing for the overlap.
  let prev: string | null = existing?.prev_secret_sealed ?? null;
  let prevUntil: number | null = existing?.prev_until_ms ?? null;
  if (existing && (await openSecret(d, existing, existing.secret_sealed)) !== q.secret) {
    prev = existing.secret_sealed;
    prevUntil = now + l.rotationOverlapMs;
  }
  const ttl = grantedTtl(q.ttlMs, l);
  await d.db
    .prepare(
      `INSERT INTO mcp_event_subscription
         (id, token_hash, user_id, thread, name, arguments, url, secret_sealed,
          prev_secret_sealed, prev_until_ms, expires_at_ms, verified_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET thread = excluded.thread, secret_sealed = excluded.secret_sealed,
         prev_secret_sealed = excluded.prev_secret_sealed, prev_until_ms = excluded.prev_until_ms,
         expires_at_ms = excluded.expires_at_ms, verified_at_ms = excluded.verified_at_ms, failures = 0`,
    )
    .bind(
      id,
      p.tokenHash,
      p.userId,
      p.thread,
      q.name,
      q.args,
      q.url,
      sealed,
      prev,
      prevUntil,
      now + ttl,
      verifiedAt,
      now,
    )
    .run();
  // Not replayable: a line missed while nobody listened is not sent later.
  return ok({
    id,
    refreshBefore: new Date(refreshAt(now, ttl)).toISOString(),
    cursor: null,
    truncated: false,
  });
}

async function openSecret(d: EventsDeps, row: Row, sealed: string): Promise<string | null> {
  if (!d.sealSecret || d.sealSecret.length < 32) return null;
  return unseal(
    await sealKey("mcp-events-secret", d.sealSecret),
    sealed,
    aad(row.id, row.token_hash),
  );
}

/** One POST with a timeout and no redirects. */
async function post(
  d: EventsDeps,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ attempt: Attempt; res?: Response }> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const res = await d.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      redirect: "manual",
      signal: ac.signal,
    });
    return { attempt: { status: res.status }, res };
  } catch {
    return { attempt: { error: timedOut ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
}

function randomToken(bytes = 24): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, "");
}

/** The signed verification request; the callback must echo the challenge. */
async function verifyCallback(
  d: EventsDeps,
  subId: string,
  url: string,
  key: Uint8Array,
  l: EventsLimits,
): Promise<"ok" | "challenge_failed" | "timeout" | "unreachable"> {
  const challenge = randomToken();
  const msgId = `msg_verification_${randomToken(12)}`;
  const body = JSON.stringify({ type: "verification", challenge });
  const ts = Math.floor(d.now() / 1000);
  const { attempt, res } = await post(
    d,
    url,
    {
      "webhook-id": msgId,
      "webhook-timestamp": String(ts),
      "webhook-signature": await signatures([key], msgId, ts, body),
      "x-mcp-subscription-id": subId,
    },
    body,
    l.timeoutMs,
  );
  if ("error" in attempt) return attempt.error === "timeout" ? "timeout" : "unreachable";
  if (attempt.status < 200 || attempt.status >= 300 || !res) return "challenge_failed";
  const text = await res.text().catch(() => "");
  if (text.length > 4096) return "challenge_failed";
  let echoed: unknown;
  try {
    echoed = (JSON.parse(text) as { challenge?: unknown }).challenge;
  } catch {
    return "challenge_failed";
  }
  return sameString(echoed, challenge) ? "ok" : "challenge_failed";
}

// ------------------------------------------------------------ the mention

/** What the hub wrote (lib/chat-log-line.ts ChatLogRequest), as far as this reads it. */
type PutRequest = { op?: unknown; thread?: unknown; lines?: unknown };

function linesOf(req: PutRequest): MentionLine[] {
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

export type MentionReport = { delivered: number; skipped: number; dropped: number };

/**
 * New lines of a thread: for each live subscription in that exact thread,
 * each person's line naming its token is sent once, signed, to its callback.
 * Never throws (the caller runs it in waitUntil).
 */
export async function mentionEvents(d: EventsDeps, raw: unknown): Promise<MentionReport> {
  const report: MentionReport = { delivered: 0, skipped: 0, dropped: 0 };
  try {
    const req = (raw && typeof raw === "object" ? raw : {}) as PutRequest;
    if (req.op !== "put" || typeof req.thread !== "string") return report;
    const lines = linesOf(req);
    // No person's line holds an @: nothing read from D1 at all.
    if (!anyCandidate(lines)) return report;
    if (!(await d.flagOn())) return report;
    const now = d.now();
    const { results } = await d.db
      .prepare(
        "SELECT * FROM mcp_event_subscription WHERE thread = ? AND name = ? AND expires_at_ms > ?",
      )
      .bind(req.thread, MENTION_EVENT, now)
      .all<Row>();
    if (!results.length) return report;
    const l = await d.limits();
    for (const sub of results) {
      const p = await principal(d, sub.token_hash, true);
      if (!p.ok) {
        // Revoked, expired or out of scope: the subscription ends with it.
        if (p.why !== "audience") await drop(d, sub.id);
        report.dropped++;
        continue;
      }
      // Only that token's own thread, as it is now.
      if (p.thread !== req.thread || p.thread !== sub.thread) {
        report.skipped++;
        continue;
      }
      for (const line of lines) {
        if (!mayTrigger(line) || !mentions(line.text, p.name)) continue;
        const allowed = await hit(
          d.db as unknown as ThrottleDb,
          `mcp-events:${sub.id}:deliver`,
          { max: l.perMinute, windowMs: 60_000 },
          d.now(),
        );
        if (!allowed.allowed) {
          report.skipped++;
          continue;
        }
        const r = await deliver(d, sub, mentionData(line), line.id, l);
        if (r === "ok") report.delivered++;
        else if (r === "gone") {
          await drop(d, sub.id);
          report.dropped++;
          break;
        } else report.skipped++;
      }
    }
  } catch (e) {
    console.error("[mcp-events] mention:", String(e).slice(0, 200));
  }
  return report;
}

async function drop(d: EventsDeps, id: string) {
  await d.db.prepare("DELETE FROM mcp_event_subscription WHERE id = ?").bind(id).run();
}

/** The live signing keys: the current secret, and the previous one during its overlap. */
async function keysOf(d: EventsDeps, sub: Row): Promise<Uint8Array[]> {
  const keys: Uint8Array[] = [];
  const cur = signingKey(await openSecret(d, sub, sub.secret_sealed));
  if (cur) keys.push(cur);
  if (sub.prev_secret_sealed && Number(sub.prev_until_ms ?? 0) > d.now()) {
    const prev = signingKey(await openSecret(d, sub, sub.prev_secret_sealed));
    if (prev) keys.push(prev);
  }
  return keys;
}

async function deliver(
  d: EventsDeps,
  sub: Row,
  data: ReturnType<typeof mentionData>,
  lineId: string,
  l: EventsLimits,
): Promise<"ok" | "gone" | "failed"> {
  const keys = await keysOf(d, sub);
  // A secret that no longer opens (AUTH_SECRET rotated): the client re-subscribes.
  if (!keys.length) return "gone";
  const id = await eventId(sub.id, lineId);
  const body = JSON.stringify({
    eventId: id,
    name: MENTION_EVENT,
    timestamp: new Date(d.now()).toISOString(),
    data,
    cursor: null,
  });
  if (new TextEncoder().encode(body).length > MAX_EVENT_BODY) return "failed";
  for (let attempt = 0; attempt <= l.retries; attempt++) {
    if (attempt) await d.sleep(backoffMs(attempt - 1, l.retryBaseMs));
    // Same eventId every attempt; a fresh timestamp and signature each time.
    const ts = Math.floor(d.now() / 1000);
    const { attempt: a } = await post(
      d,
      sub.url,
      {
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": await signatures(keys, id, ts, body),
        "x-mcp-subscription-id": sub.id,
      },
      body,
      l.timeoutMs,
    );
    const o = outcome(a);
    if (o === "ok") {
      await d.db
        .prepare(
          "UPDATE mcp_event_subscription SET last_event_at_ms = ?, failures = 0 WHERE id = ?",
        )
        .bind(d.now(), sub.id)
        .run();
      return "ok";
    }
    if (o === "gone") return "gone";
    if (o === "final") break;
  }
  await d.db
    .prepare("UPDATE mcp_event_subscription SET failures = failures + 1 WHERE id = ?")
    .bind(sub.id)
    .run();
  return "failed";
}
