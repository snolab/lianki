/**
 * POST /api/stt/session: a session on Lianki's speech servers for one account
 * (docs/local-stt.md, "Lianki's speech servers for everyone"; flag stt.worker).
 *
 * Flag off: 404, whoever asks. On: a signed-in account on the /dev/stt-access
 * allowlist, under its quotas, gets a v2 ticket (lib/stt-ticket.ts: the
 * account id, scope "stt", the utterance and session limits, 60 s, once), the
 * ICE servers for WebRTC (STUN; TURN only when its key is set), and where to
 * signal (the SttRegistry in lianki-push). Every refusal is a reason code; the
 * page then uses the cloud for that utterance, as on any failure.
 *
 * Quotas (config stt.worker.*): tickets per minute per account (counted in D1
 * `stt_ticket`) and audio minutes per JST day (the account's
 * `speech.stt.local` rows in the cost ledger). Live sessions per account and
 * each server's capacity are the registry's (it sees the sockets).
 */
import type { ConfigKey } from "@/lib/config";
import { COST_DAY_OFFSET_MS, LOCAL_STT_FEATURE } from "@/lib/payments/cost-ledger";
import { signSttTicketV2 } from "@/lib/stt-ticket";
import type { SttDb } from "./store";

/** Where the page signals its WebRTC offer (workers/push, SttRegistry). Same origin, routed to lianki-push. */
export const STT_SIGNAL_PATH = "/api/version/stt/signal";
/** The subprotocol the signal socket and the peer listener select beside a v2 ticket. */
export const STT_V2_SUBPROTOCOL = "lianki-stt2";
/** stt_ticket rows older than this are deleted when the same account asks again. */
const KEEP_TICKETS_MS = 86_400_000;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export type SttSessionOk = {
  ticket: string;
  exp: number;
  signal: string;
  iceServers: IceServer[];
  /** The WSS fallback (a tunnel to a speech server), when one is configured. */
  wss?: string;
  limits: { utteranceS: number; sessionS: number };
};

type NumKey = Extract<
  ConfigKey,
  | "stt.worker.ticketsPerMin"
  | "stt.worker.minutesPerDay"
  | "stt.worker.maxUtteranceS"
  | "stt.worker.sessionMaxS"
  | "stt.worker.sessionsPerAccount"
>;

export type SttSessionDeps = {
  /** The flag stt.worker (fail closed: an error is off). */
  flag: () => Promise<boolean>;
  user: { id: string } | null;
  allowed: (userId: string) => Promise<boolean>;
  db: SttDb | null;
  num: (key: NumKey) => Promise<number>;
  text: (key: "stt.worker.stunUrls" | "stt.worker.wssUrl") => Promise<string>;
  /** The ticket signing key (STT_TICKET_KEY), or null when it is not set. */
  key: () => Promise<CryptoKey | null>;
  /** TURN servers for this session (short-lived credentials), or null without a TURN key. */
  turn?: () => Promise<IceServer[] | null>;
  now?: () => number;
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });
const notFound = () =>
  new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

/** The STUN URLs from config: space or comma separated, stun: / stuns: only. */
export function stunServers(raw: string): IceServer[] {
  const urls = raw.split(/[\s,]+/).filter((u) => /^stuns?:[A-Za-z0-9.-]+(:\d{1,5})?$/.test(u));
  return urls.length ? [{ urls }] : [];
}

/** The WSS fallback from config: one wss:// URL, or nothing. */
export function wssRoute(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "wss:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Audio seconds this account was served today (JST), from the cost ledger. */
export async function secondsToday(db: SttDb, userId: string, now: number): Promise<number> {
  const day = new Date(now + COST_DAY_OFFSET_MS).toISOString().slice(0, 10);
  const r = await db
    .prepare(
      "SELECT COALESCE(SUM(units), 0) AS s FROM cost_ledger WHERE user_id = ?1 AND feature = ?2 AND day = ?3",
    )
    .bind(userId, LOCAL_STT_FEATURE, day)
    .first<{ s: number }>();
  return Number(r?.s ?? 0);
}

export async function handleSttSession(req: Request, d: SttSessionDeps): Promise<Response> {
  let on = false;
  try {
    on = await d.flag();
  } catch {}
  if (!on) return notFound();
  // GET: may this account use them at all? Asked once when the mic turns on (no
  // ticket, no quota): 204, or 404 like everyone the feature is not for.
  if (req.method === "GET") {
    const id = d.user?.id;
    return id && (await d.allowed(id))
      ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
      : notFound();
  }
  if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
  const userId = d.user?.id;
  if (!userId) return json({ error: "login-required" }, 401);
  if (!(await d.allowed(userId))) return json({ error: "not-allowed" }, 403);
  const db = d.db;
  if (!db) return json({ error: "unavailable" }, 503);
  const now = d.now?.() ?? Date.now();

  if ((await d.num("stt.worker.sessionsPerAccount")) <= 0) return json({ error: "off" }, 403);
  const perMin = await d.num("stt.worker.ticketsPerMin");
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM stt_ticket WHERE user_id = ?1 AND at > ?2")
    .bind(userId, now - 60_000)
    .first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= perMin)
    return json({ error: "too-many-tickets" }, 429, { "retry-after": "60" });
  const minutes = await d.num("stt.worker.minutesPerDay");
  if ((await secondsToday(db, userId, now)) >= minutes * 60)
    return json({ error: "daily-limit" }, 429);

  const key = await d.key().catch(() => null);
  if (!key) return json({ error: "tickets-off" }, 503);
  const lim = {
    utt: await d.num("stt.worker.maxUtteranceS"),
    sess: await d.num("stt.worker.sessionMaxS"),
  };
  const { ticket, exp, payload } = await signSttTicketV2(key, { sub: userId, lim, now });
  await db
    .prepare("DELETE FROM stt_ticket WHERE user_id = ?1 AND at < ?2")
    .bind(userId, now - KEEP_TICKETS_MS)
    .run();
  await db
    .prepare("INSERT INTO stt_ticket (jti, user_id, at) VALUES (?1, ?2, ?3)")
    .bind(payload.jti, userId, now)
    .run();

  const turn = (await d.turn?.().catch(() => null)) ?? null;
  const body: SttSessionOk = {
    ticket,
    exp,
    signal: STT_SIGNAL_PATH,
    iceServers: [...stunServers(await d.text("stt.worker.stunUrls")), ...(turn ?? [])],
    limits: { utteranceS: lim.utt, sessionS: lim.sess },
  };
  const wss = wssRoute(await d.text("stt.worker.wssUrl"));
  if (wss) body.wss = wss;
  return json(body);
}

/**
 * Short-lived TURN credentials from Cloudflare Realtime TURN, for one session
 * (the TURN fallback when STUN cannot pair). Needs the Worker secrets
 * STT_TURN_KEY_ID and STT_TURN_KEY_TOKEN, which are not set yet (the owner's
 * approval first); without them: null, STUN only.
 */
export async function cloudflareTurn(
  env: { STT_TURN_KEY_ID?: string; STT_TURN_KEY_TOKEN?: string },
  ttlS: number,
  f: typeof fetch = fetch,
): Promise<IceServer[] | null> {
  const id = env.STT_TURN_KEY_ID;
  const token = env.STT_TURN_KEY_TOKEN;
  if (!id || !token || !/^[A-Za-z0-9]+$/.test(id)) return null;
  const r = await f(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: Math.max(60, Math.min(86_400, Math.floor(ttlS))) }),
    },
  );
  if (!r.ok) return null;
  const b = (await r.json().catch(() => null)) as { iceServers?: unknown } | null;
  const list = Array.isArray(b?.iceServers) ? b.iceServers : b?.iceServers ? [b.iceServers] : [];
  return (list as IceServer[]).filter(
    (s) => s && (typeof s.urls === "string" || Array.isArray(s.urls)),
  );
}
