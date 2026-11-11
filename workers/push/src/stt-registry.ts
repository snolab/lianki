/**
 * SttRegistry: Lianki's speech servers find the pages that want them
 * (docs/local-stt.md, "Lianki's speech servers for everyone"; flag stt.worker).
 *
 *   GET /api/version/stt/worker   WebSocket, dialled OUT by a speech server's
 *                                 stt-peer (no inbound port on the server). Not
 *                                 a browser: an Origin is refused. The hub sends
 *                                 {t:"challenge", nonce}; the worker answers
 *                                 {t:"auth", key, sig} — Ed25519 over
 *                                 "lianki-stt-worker\n<nonce>" with the key whose
 *                                 public half is a live stt_worker row (the main
 *                                 Worker's DebugSessions.sttWorker). Else 4401.
 *   GET /api/version/stt/signal   WebSocket from a lianki.com page, offering
 *                                 "lianki-stt2, <v2 ticket>" (/api/stt/session).
 *                                 The ticket is checked here (signature, claims,
 *                                 once: jtis kept in storage), the account's live
 *                                 sessions counted, a worker with room picked —
 *                                 the account's own worker first, then a shared
 *                                 one under capacity − reserved — before the
 *                                 upgrade; else 401/429/503, and the page uses
 *                                 the cloud. Then the WebRTC offer/answer and ICE
 *                                 pass between the page and that worker. The
 *                                 ticket goes on to the worker, whose speech
 *                                 server checks it again (ticket.py).
 *
 * Both answer 404 while the flag is off (index.ts checks it before the hub).
 * Usage the worker reports ({t:"usage", sid, audioMs}) is booked to the
 * ticket's account as `speech.stt.local` (DebugSessions.bookStt): the page
 * never books these itself. Nothing polls: a session past its signed length
 * (+ grace) is dropped when the hub next counts.
 */
import {
  STT_TICKET_V2_AUD,
  importTicketPublicKey,
  type JtiStore,
  verifySttTicketV2,
} from "../../../lib/stt-ticket";

export const STT_WORKER_PATH = "/api/version/stt/worker";
export const STT_SIGNAL_PATH = "/api/version/stt/signal";
export const STT_V2_SUBPROTOCOL = "lianki-stt2";
export const STT_ORIGIN = "https://lianki.com";
/** What a worker signs: this prefix, a newline, the hub's nonce. */
export const WORKER_AUTH_PREFIX = "lianki-stt-worker\n";
/** A worker that has not authenticated within this long is closed when next seen. */
const AUTH_GRACE_MS = 10_000;
/** A session is counted until its signed length plus this. */
const SESSION_GRACE_MS = 60_000;
/** Config and flag values are kept this long (as the main Worker's own cache). */
const CACHE_MS = 30_000;
/** The biggest signalling message passed on (an SDP is a few KB). */
const MAX_MSG = 64 * 1024;

type Socket = WebSocket & {
  serializeAttachment?(v: unknown): void;
  deserializeAttachment?(): unknown;
};
type Storage = {
  get<T>(k: string): Promise<T | undefined>;
  put(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<unknown>;
  list<T>(o: { prefix: string; limit?: number }): Promise<Map<string, T>>;
};
type State = {
  acceptWebSocket(ws: Socket, tags?: string[]): void;
  getWebSockets(tag?: string): Socket[];
  storage: Storage;
};
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

/** The main Worker's answers (worker.ts DebugSessions). */
export type SttSessions = {
  flag(key: string): Promise<unknown>;
  config(key: string): Promise<unknown>;
  sttWorker?(pubkey: string): Promise<unknown>;
  bookStt?(userId: string, audioMs: number): Promise<unknown>;
};
export type SttEnv = { SESSIONS?: SttSessions; PARTNER_TICKET_PUB?: string };

type WorkerRow = { id: string; ownerUserId: string | null; capacity: number | null };
type WorkerTag = { role: "worker"; nonce: string; at: number; w?: WorkerRow; key?: string };
type PageTag = {
  role: "page";
  sid: string;
  sub: string;
  worker: string;
  until: number;
  ticket: string;
};
type Tag = WorkerTag | PageTag;

const tagOf = (ws: Socket): Tag | null => {
  try {
    return (ws.deserializeAttachment?.() as Tag | null) ?? null;
  } catch {
    return null;
  }
};
const send = (ws: Socket, m: unknown) => {
  try {
    ws.send(JSON.stringify(m));
  } catch {}
};
const close = (ws: Socket, code: number, why: string) => {
  try {
    ws.close(code, why);
  } catch {}
};
const rand = (n: number) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
const fromB64url = (s: string) => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const SID_RE = /^[A-Za-z0-9_-]{16,32}$/;

const isWorkerRow = (x: unknown): x is WorkerRow => {
  const r = x as Partial<WorkerRow> | null;
  return (
    !!r &&
    typeof r.id === "string" &&
    (r.ownerUserId === null || typeof r.ownerUserId === "string") &&
    (r.capacity === null || (Number.isInteger(r.capacity) && (r.capacity as number) >= 0))
  );
};

/** Does `sig` sign the nonce with `key` (raw Ed25519, base64url)? */
export async function workerSigned(key: string, nonce: string, sig: string): Promise<boolean> {
  if (!KEY_RE.test(key) || !SIG_RE.test(sig)) return false;
  try {
    const k = await crypto.subtle.importKey(
      "raw",
      fromB64url(key) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      k,
      fromB64url(sig) as BufferSource,
      new TextEncoder().encode(WORKER_AUTH_PREFIX + nonce),
    );
  } catch {
    return false;
  }
}

export class SttRegistry {
  private cache = new Map<string, { v: unknown; at: number }>();

  constructor(
    private ctx: State,
    private env: SttEnv,
    private now: () => number = Date.now,
  ) {}

  /** A config value (number), read through the main Worker and kept 30 s; the default on failure. */
  private async num(key: string, dflt: number): Promise<number> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.v as number;
    let v = dflt;
    try {
      const r = await this.env.SESSIONS?.config(key);
      if (typeof r === "number" && Number.isFinite(r)) v = r;
    } catch {}
    this.cache.set(key, { v, at: this.now() });
    return v;
  }

  private workers(): { ws: Socket; t: WorkerTag & { w: WorkerRow } }[] {
    const out: { ws: Socket; t: WorkerTag & { w: WorkerRow } }[] = [];
    for (const ws of this.ctx.getWebSockets("worker")) {
      const t = tagOf(ws) as WorkerTag | null;
      if (t?.w) out.push({ ws, t: t as WorkerTag & { w: WorkerRow } });
      else if (t && this.now() - t.at > AUTH_GRACE_MS) close(ws, 4401, "no auth");
    }
    return out;
  }

  /** Live page sessions with this tag; one past its signed length is closed now. */
  private pages(tag: string): { ws: Socket; t: PageTag }[] {
    const out: { ws: Socket; t: PageTag }[] = [];
    for (const ws of this.ctx.getWebSockets(tag)) {
      const t = tagOf(ws) as PageTag | null;
      if (!t || t.role !== "page") continue;
      if (t.until < this.now()) {
        close(ws, 4408, "session over");
        continue;
      }
      out.push({ ws, t });
    }
    return out;
  }

  private page(sid: string): { ws: Socket; t: PageTag } | null {
    return this.pages(`sid:${sid}`)[0] ?? null;
  }

  /** Spend a jti once, across restarts (storage); expired ones are swept as we go. */
  private async spend(jti: string, exp: number): Promise<boolean> {
    const k = `jti:${jti}`;
    if (await this.ctx.storage.get(k)) return false;
    await this.ctx.storage.put(k, exp);
    const old = await this.ctx.storage.list<number>({ prefix: "jti:", limit: 50 });
    const t = Math.floor(this.now() / 1000);
    for (const [key, e] of old) if (e + 10 < t) await this.ctx.storage.delete(key);
    return true;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === STT_WORKER_PATH) {
      if (req.headers.get("origin")) return new Response(null, { status: 403 });
      const pair = new WebSocketPair();
      const nonce = rand(24);
      this.ctx.acceptWebSocket(pair[1], ["worker"]);
      pair[1].serializeAttachment?.({ role: "worker", nonce, at: this.now() } satisfies WorkerTag);
      send(pair[1], { t: "challenge", nonce });
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (path === STT_SIGNAL_PATH) return this.signal(req);
    return new Response(null, { status: 404 });
  }

  private async signal(req: Request): Promise<Response> {
    if (req.headers.get("origin") !== STT_ORIGIN) return new Response(null, { status: 403 });
    const offered = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (offered.length !== 2 || offered[0] !== STT_V2_SUBPROTOCOL || !this.env.PARTNER_TICKET_PUB)
      return new Response(null, { status: 401 });
    const ticket = offered[1];
    let payload;
    try {
      const pub = await importTicketPublicKey(this.env.PARTNER_TICKET_PUB);
      const probe: JtiStore = new Map();
      const r = await verifySttTicketV2(ticket, pub, probe, this.now());
      if (!r.ok || r.payload.aud !== STT_TICKET_V2_AUD) return new Response(null, { status: 401 });
      payload = r.payload;
    } catch {
      return new Response(null, { status: 401 });
    }
    if (!(await this.spend(payload.jti, payload.exp))) return new Response(null, { status: 401 });

    const sub = payload.sub;
    const perAccount = await this.num("stt.worker.sessionsPerAccount", 1);
    if (this.pages(`sub:${sub}`).length >= perAccount) return new Response(null, { status: 429 });

    const cap = await this.num("stt.worker.macCapacity", 3);
    const reserved = await this.num("stt.worker.macReserved", 1);
    const workers = this.workers();
    const room = (w: WorkerRow, shared: boolean) =>
      this.pages(`w:${w.id}`).length < Math.max(0, (w.capacity ?? cap) - (shared ? reserved : 0));
    // The account's own worker first (later: a user's own Mac), then a shared one.
    const own = workers.find(({ t }) => t.w.ownerUserId === sub && room(t.w, false));
    const shared = workers
      .filter(({ t }) => t.w.ownerUserId === null && room(t.w, true))
      .sort((a, b) => this.pages(`w:${a.t.w.id}`).length - this.pages(`w:${b.t.w.id}`).length)[0];
    const pick = own ?? shared;
    if (!pick) return new Response(null, { status: 503 });

    const sid = rand(18);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["page", `sub:${sub}`, `w:${pick.t.w.id}`, `sid:${sid}`]);
    pair[1].serializeAttachment?.({
      role: "page",
      sid,
      sub,
      worker: pick.t.w.id,
      until: this.now() + payload.lim.sess * 1000 + SESSION_GRACE_MS,
      ticket,
    } satisfies PageTag);
    send(pair[1], { t: "ready", sid });
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": STT_V2_SUBPROTOCOL },
    } as ResponseInit);
  }

  private workerById(id: string): Socket | null {
    return this.workers().find(({ t }) => t.w.id === id)?.ws ?? null;
  }

  async webSocketMessage(ws: Socket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const t = tagOf(ws);
    if (t?.role === "worker") return this.fromWorker(ws, t, m);
    if (t?.role === "page") return this.fromPage(t, m);
  }

  private async fromWorker(ws: Socket, t: WorkerTag, m: Record<string, unknown>) {
    if (!t.w) {
      if (m.t !== "auth" || typeof m.key !== "string" || typeof m.sig !== "string")
        return close(ws, 4401, "auth first");
      if (!(await workerSigned(m.key, t.nonce, m.sig))) return close(ws, 4401, "bad signature");
      let row: unknown = null;
      try {
        row = await this.env.SESSIONS?.sttWorker?.(m.key);
      } catch {}
      if (!isWorkerRow(row)) return close(ws, 4403, "unknown worker");
      // One socket per worker: a reconnect replaces the old one.
      for (const o of this.workers()) if (o.t.w.id === row.id) close(o.ws, 4409, "replaced");
      ws.serializeAttachment?.({ ...t, w: row, key: m.key } satisfies WorkerTag);
      return send(ws, { t: "registered", id: row.id });
    }
    const sid = typeof m.sid === "string" && SID_RE.test(m.sid) ? m.sid : null;
    const p = sid ? this.page(sid) : null;
    // A worker speaks only for its own sessions.
    if (!p || p.t.worker !== t.w.id) return;
    if (m.t === "answer" && typeof m.sdp === "string") send(p.ws, { t: "answer", sdp: m.sdp });
    else if (m.t === "ice") send(p.ws, { t: "ice", candidate: m.candidate ?? null });
    else if (m.t === "usage") {
      const ms = Number(m.audioMs);
      if (Number.isFinite(ms) && ms > 0)
        try {
          await this.env.SESSIONS?.bookStt?.(p.t.sub, Math.min(ms, 120_000));
        } catch {}
    } else if (m.t === "end") {
      send(p.ws, { t: "end", reason: typeof m.reason === "string" ? m.reason.slice(0, 40) : "" });
      close(p.ws, 1000, "end");
    }
  }

  private fromPage(t: PageTag, m: Record<string, unknown>) {
    const w = this.workerById(t.worker);
    if (!w) return;
    if (m.t === "offer" && typeof m.sdp === "string")
      send(w, { t: "offer", sid: t.sid, sdp: m.sdp, ticket: t.ticket });
    else if (m.t === "ice") send(w, { t: "ice", sid: t.sid, candidate: m.candidate ?? null });
  }

  webSocketClose(ws: Socket, code: number) {
    const t = tagOf(ws);
    if (t?.role === "page") {
      const w = this.workerById(t.worker);
      if (w) send(w, { t: "close", sid: t.sid });
    } else if (t?.role === "worker" && t.w) {
      // Its pages go on with the next route (the WSS tunnel or the cloud).
      for (const p of this.pages(`w:${t.w.id}`)) {
        send(p.ws, { t: "end", reason: "worker-gone" });
        close(p.ws, 1012, "worker gone");
      }
    }
    close(ws, code === 1005 ? 1000 : code, "");
  }

  webSocketError(ws: Socket) {
    this.webSocketClose(ws, 1011);
  }
}
