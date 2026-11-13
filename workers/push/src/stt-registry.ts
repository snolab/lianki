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
 * Routes that come and go (docs/local-stt.md): a worker pings ("ping" → "pong",
 * answered by the runtime while the hub sleeps) and one silent for WORKER_SILENT_MS is
 * closed when next seen; a worker's own socket dropping (a redeploy, a blip) does not
 * end its sessions (they are peer to peer), its pages only hear `worker-away` and
 * `worker-back`. A page's signal socket that drops (not closed by the page) leaves its
 * session resumable for RESUME_GRACE_MS: the page reconnects with
 * "lianki-stt2-resume, <sid>.<resume>" and goes on (an ICE restart's offer passes as
 * any offer). With `?lobby=1` and no worker free, the page waits on a lobby socket
 * instead of a 503, and is told `available` when a worker registers or room frees.
 * Workers are picked: the account's own first, then by same Cloudflare colo as the
 * page, then by load (sessions ÷ capacity).
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
/** A worker that has not pinged for this long is closed when next seen (stt-peer pings every 15 s). */
export const WORKER_SILENT_MS = 45_000;
/** A page's dropped signal socket may resume its session for this long. */
export const RESUME_GRACE_MS = 20_000;
export const STT_RESUME_SUBPROTOCOL = "lianki-stt2-resume";
/** The colo the push Worker saw the request at (index.ts sets it; a client's own is dropped). */
export const COLO_HEADER = "x-lk-colo";
const PING = "ping";
const PONG = "pong";

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
  setWebSocketAutoResponse?(pair?: unknown): void;
  getWebSocketAutoResponseTimestamp?(ws: Socket): Date | null;
};
type PairCtor = new (req: string, res: string) => unknown;
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
type WorkerTag = {
  role: "worker";
  nonce: string;
  at: number;
  w?: WorkerRow;
  key?: string;
  colo?: string;
};
type PageTag = {
  role: "page";
  sid: string;
  sub: string;
  worker: string;
  until: number;
  ticket: string;
  /** What a dropped signal socket shows to resume this session. */
  resume?: string;
};
type LobbyTag = { role: "lobby"; sub: string; until: number };
type Tag = WorkerTag | PageTag | LobbyTag;
/** A session whose signal socket dropped: resumable until `at` + RESUME_GRACE_MS. */
type Detached = PageTag & { at: number };

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
  ) {
    // Workers ping; the runtime answers while the hub hibernates, and keeps the time.
    const Pair = (globalThis as { WebSocketRequestResponsePair?: PairCtor })
      .WebSocketRequestResponsePair;
    if (Pair) ctx.setWebSocketAutoResponse?.(new Pair(PING, PONG));
  }

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
      if (t?.w) {
        // Silent too long (a worker that pings, gone without a close): closed, it redials.
        const last = this.ctx.getWebSocketAutoResponseTimestamp?.(ws)?.getTime();
        if (last !== undefined && this.now() - last > WORKER_SILENT_MS) {
          close(ws, 4408, "silent");
          continue;
        }
        out.push({ ws, t: t as WorkerTag & { w: WorkerRow } });
      } else if (t && this.now() - t.at > AUTH_GRACE_MS) close(ws, 4401, "no auth");
    }
    return out;
  }

  /** Pages waiting for a worker are told one may be free now (they race again). */
  private wakeLobby() {
    for (const ws of this.ctx.getWebSockets("lobby")) {
      send(ws, { t: "available" });
      close(ws, 1000, "available");
    }
  }

  /** Sessions whose page did not come back in time: their worker is told to close them. */
  private async sweep() {
    const old = await this.ctx.storage.list<Detached>({ prefix: "det:", limit: 50 });
    for (const [k, d] of old) {
      if (this.now() - d.at <= RESUME_GRACE_MS && d.until > this.now()) continue;
      await this.ctx.storage.delete(k);
      const w = this.workerById(d.worker);
      if (w) send(w, { t: "close", sid: d.sid });
    }
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
      const colo = req.headers.get(COLO_HEADER) ?? undefined;
      pair[1].serializeAttachment?.({
        role: "worker",
        nonce,
        at: this.now(),
        ...(colo ? { colo } : {}),
      } satisfies WorkerTag);
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
    await this.sweep();
    if (offered.length === 2 && offered[0] === STT_RESUME_SUBPROTOCOL)
      return this.resume(offered[1]);
    if (offered.length !== 2 || offered[0] !== STT_V2_SUBPROTOCOL || !this.env.PARTNER_TICKET_PUB)
      return new Response(null, { status: 401 });
    const lobby = new URL(req.url).searchParams.get("lobby") === "1";
    const colo = req.headers.get(COLO_HEADER) ?? undefined;
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
    const limit = (w: WorkerRow, shared: boolean) =>
      Math.max(0, (w.capacity ?? cap) - (shared ? reserved : 0));
    const load = (w: WorkerRow) => this.pages(`w:${w.id}`).length;
    const room = (w: WorkerRow, shared: boolean) => load(w) < limit(w, shared);
    // Nearest first (the page and the worker at the same Cloudflare colo), then the least loaded.
    const order = (shared: boolean) => (a: { t: WorkerTag & { w: WorkerRow } }, b: typeof a) =>
      Number(!!colo && b.t.colo === colo) - Number(!!colo && a.t.colo === colo) ||
      load(a.t.w) / Math.max(1, limit(a.t.w, shared)) -
        load(b.t.w) / Math.max(1, limit(b.t.w, shared));
    // The account's own workers first (its own Mac), then a shared one.
    const own = workers
      .filter(({ t }) => t.w.ownerUserId === sub && room(t.w, false))
      .sort(order(false))[0];
    const shared = workers
      .filter(({ t }) => t.w.ownerUserId === null && room(t.w, true))
      .sort(order(true))[0];
    const pick = own ?? shared;
    if (!pick && lobby) {
      // No worker free: the page waits here (the cloud meanwhile) and hears when one is.
      for (const o of this.ctx.getWebSockets(`lobby:${sub}`)) close(o, 4409, "replaced");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["lobby", `lobby:${sub}`]);
      pair[1].serializeAttachment?.({
        role: "lobby",
        sub,
        until: this.now() + payload.lim.sess * 1000,
      } satisfies LobbyTag);
      send(pair[1], { t: "wait" });
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "sec-websocket-protocol": STT_V2_SUBPROTOCOL },
      } as ResponseInit);
    }
    if (!pick) return new Response(null, { status: 503 });

    const sid = rand(18);
    const resume = rand(24);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["page", `sub:${sub}`, `w:${pick.t.w.id}`, `sid:${sid}`]);
    pair[1].serializeAttachment?.({
      role: "page",
      sid,
      sub,
      worker: pick.t.w.id,
      until: this.now() + payload.lim.sess * 1000 + SESSION_GRACE_MS,
      ticket,
      resume,
    } satisfies PageTag);
    send(pair[1], { t: "ready", sid, resume });
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": STT_V2_SUBPROTOCOL },
    } as ResponseInit);
  }

  /**
   * A page back after its signal socket dropped ("<sid>.<resume>"): the same session,
   * the same worker, a fresh resume token. Else 401, and the page starts anew.
   */
  private async resume(cred: string): Promise<Response> {
    const [sid, token] = cred.split(".");
    if (!sid || !token || !SID_RE.test(sid)) return new Response(null, { status: 401 });
    const k = `det:${sid}`;
    const d = await this.ctx.storage.get<Detached>(k);
    if (!d || d.resume !== token || this.now() - d.at > RESUME_GRACE_MS || d.until <= this.now())
      return new Response(null, { status: 401 });
    await this.ctx.storage.delete(k);
    const { at: _at, ...t } = d;
    const resume = rand(24);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["page", `sub:${t.sub}`, `w:${t.worker}`, `sid:${sid}`]);
    pair[1].serializeAttachment?.({ ...t, resume } satisfies PageTag);
    send(pair[1], { t: "ready", sid, resume, resumed: true });
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": STT_RESUME_SUBPROTOCOL },
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
      send(ws, { t: "registered", id: row.id });
      // Its sessions go on (peer to peer): their pages hear it is back for signalling.
      for (const p of this.pages(`w:${row.id}`)) send(p.ws, { t: "worker-back" });
      this.wakeLobby();
      return;
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

  async webSocketClose(ws: Socket, code: number) {
    const t = tagOf(ws);
    if (t?.role === "page") {
      if (code === 1000 || code === 1005 || t.until <= this.now()) {
        // The page ended it.
        const w = this.workerById(t.worker);
        if (w) send(w, { t: "close", sid: t.sid });
        this.wakeLobby(); // room freed
      } else {
        // Dropped (a network change): resumable for a while; the worker keeps the session.
        await this.ctx.storage.put(`det:${t.sid}`, { ...t, at: this.now() } satisfies Detached);
      }
    } else if (t?.role === "worker" && t.w) {
      // Its sessions are peer to peer and go on; if the worker is really gone, they fail
      // on their own and the page takes the next route. Signalling waits for it. (A
      // socket replaced by the worker's own redial: it is back already.)
      const id = t.w.id;
      if (!this.workers().some((o) => o.ws !== ws && o.t.w.id === id))
        for (const p of this.pages(`w:${id}`)) send(p.ws, { t: "worker-away" });
    }
    close(ws, code === 1005 ? 1000 : code, "");
  }

  async webSocketError(ws: Socket) {
    await this.webSocketClose(ws, 1011);
  }
}
