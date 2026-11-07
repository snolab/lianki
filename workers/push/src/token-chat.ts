/**
 * Token chat: `lianki chat say | ask | read | listen` (packages/lianki-cli),
 * authenticated with an API token (lib/api-tokens.ts), held by DebugHub
 * (debug.ts calls in here). docs/lianki-dev-cli.md, "lianki chat".
 *
 *   POST /api/version/chat  Authorization: Bearer lk_…
 *        {op:"say", text, quiet?}                → {ok, id}
 *        {op:"ask", question, options | questions, expiresAt?} → {ok, id, askId}
 *        {op:"read", limit?}                     → {ok, thread, lane, messages}
 *   GET  /api/version/chat  (WebSocket) first message {type:"auth", token, history?};
 *        then {type:"say"|"ask", …}; hears {type:"chat"|"edited"|"answered"}.
 *
 * Scope, deny by default. The main Worker's DebugSessions.chatToken
 * (lib/chat-token.ts, over the SESSIONS binding) checks the token for the
 * operation's permission, its expiry, its account and its rate limit, and
 * names the one thread the token may use: its account's own (the owner's
 * thread for the owner's account, else that user's Learning Partner thread).
 * Nothing in a request can name a thread, a node, a page or another user.
 * There is no eval, pairing, grant, inbox, clips or answer here: a token
 * socket is not a controller and none of the controller's messages reach it.
 *
 * Lines. A token's line is an agent line (`from: "agent"`, never the owner's
 * or the user's words), `via: "token"`, `lane` = the token's name, its text
 * starting 【lane】, label the lane. So the owner's lanes (eval.ts listeners)
 * and pages see who posted it, and a token can never speak as the owner.
 *
 * Ask cards. A token's ask is answered only by a tap on a page of that thread
 * (debug.ts answer: pages only, never a token or controller), and the
 * `answered` event goes to that thread's pages and to the token sockets of the
 * same account and lane, and to no other listener. A read or listen of
 * another lane's (or a controller's) ask carries no answer.
 *
 * Revocation. A listening socket keeps the token's hash only, never the
 * secret. It closes when the main Worker says the token was revoked
 * (/internal/chat-tokens/revoked), when it expires (checked on every event
 * for it), or when a re-check (at most every RECHECK_MS, before a delivery)
 * finds it gone. No timers, no polling.
 */
import type { ChatMessage, EditedEvent } from "../../../packages/debug-chat/src/wire";
import { type Ask, parseAsk, askText } from "../../../packages/debug-chat/src/ask";
import { OWNER_THREAD, chatText, isUserId } from "../../../lib/dev-eval";

export const CHAT_PATH = "/api/version/chat";
export const REVOKED_PATH = "/internal/chat-tokens/revoked";
/** A socket that has not sent its token within this long is closed. */
export const AUTH_MS = 10_000;
/** A listening socket's token is checked again before a delivery at most this often. */
export const RECHECK_MS = 5 * 60_000;
/** Sockets one token may hold open; a newer one closes the oldest. */
export const MAX_SOCKETS_PER_TOKEN = 4;
export const MAX_READ = 100;
const MAX_BODY = 16_384;
/** Close codes. */
export const TOKEN_REFUSED = 4401;
export const TOKEN_REPLACED = 4409;
const TOKEN_RE = /^lk_[0-9a-f]{64}$/;

export type TokenSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};

/** A token socket's attachment. Without `thread`, it has not authenticated yet. */
export type TokenAtt = {
  role: "token";
  at: number;
  thread?: string;
  userId?: string;
  lane?: string;
  tag?: string;
  /** The token's SHA-256: what a re-check names it by. Never the secret. */
  hash?: string;
  until?: number | null;
  checkedAt?: number;
};

export type ChatTokenOp = "say" | "ask" | "read" | "listen" | "recheck";
export type ChatTokenAnswer =
  | {
      ok: true;
      userId: string;
      owner: boolean;
      lane: string;
      id: string;
      tag: string;
      expiresAt: number | null;
    }
  | { ok: false; error: string; retryAfterMs?: number };
export type ChatTokenRpc = {
  chatToken?(req: { op: ChatTokenOp; token?: string; tokenHash?: string }): Promise<unknown>;
};

export interface TokenHost {
  now(): number;
  rpc(): ChatTokenRpc | undefined;
  sockets(): TokenSocket[];
  post(m: ChatMessage & { thread: string }): Promise<void>;
  history(thread: string): Promise<ChatMessage[]>;
  /** Is this (non-owner) user blocked from the chat? */
  blocked(userId: string): Promise<boolean>;
}

const send = (ws: TokenSocket, msg: unknown) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
};
const close = (ws: TokenSocket, code: number, reason: string) => {
  try {
    ws.close(code, reason);
  } catch {}
};
export const tokenAtt = (ws: TokenSocket): TokenAtt | null => {
  try {
    const a = ws.deserializeAttachment() as { role?: unknown } | null;
    return a?.role === "token" ? (a as TokenAtt) : null;
  } catch {
    return null;
  }
};

/** A token line's text: 【lane】 first (once), within the chat's limit. */
export function laneText(lane: string, text: string): string | undefined {
  const head = `【${lane}】`;
  return chatText(text.startsWith(head) ? text : `${head}${text}`);
}

/** May this lane see the answer on this line? Only on its own ask. */
const ownsAsk = (m: ChatMessage, lane: string | undefined) =>
  m.via === "token" && lane !== undefined && m.lane === lane;
/** A line as one token sees it: another lane's (or a controller's) answer left out. */
export function forLane(m: ChatMessage, lane: string | undefined): ChatMessage {
  if (!m.answer || ownsAsk(m, lane)) return m;
  const { answer: _drop, ...rest } = m;
  return rest;
}

type Verified = Extract<ChatTokenAnswer, { ok: true }>;
const STATUS: Record<string, number> = {
  "bad request": 400,
  unknown: 401,
  expired: 401,
  scope: 403,
  rate: 429,
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export class TokenChat {
  constructor(private host: TokenHost) {}

  private async check(
    op: ChatTokenOp,
    cred: { token: string } | { tokenHash: string },
  ): Promise<ChatTokenAnswer> {
    const rpc = this.host.rpc();
    if (!rpc?.chatToken) return { ok: false, error: "unavailable" };
    try {
      const a = (await rpc.chatToken({ op, ...cred })) as ChatTokenAnswer | null;
      if (!a || typeof a !== "object") return { ok: false, error: "unavailable" };
      if (a.ok !== true)
        return { ok: false, error: String(a.error ?? "refused"), retryAfterMs: a.retryAfterMs };
      // Only what a thread can be named from: a well-formed user id.
      if (!isUserId(a.userId) || typeof a.lane !== "string" || !a.lane)
        return { ok: false, error: "unavailable" };
      return a;
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }

  /** The token's own thread, or null when its user is blocked. */
  private async threadOf(v: Verified): Promise<string | null> {
    if (v.owner) return OWNER_THREAD;
    return (await this.host.blocked(v.userId)) ? null : v.userId;
  }

  private line(thread: string, lane: string, text: string, extra: Partial<ChatMessage> = {}) {
    return {
      id: crypto.randomUUID().slice(0, 8),
      from: "agent" as const,
      label: lane,
      text,
      at: this.host.now(),
      thread,
      via: "token" as const,
      lane,
      ...extra,
    } satisfies ChatMessage & { thread: string };
  }

  private async say(thread: string, lane: string, m: Record<string, unknown>) {
    const text = typeof m.text === "string" ? laneText(lane, m.text.trim()) : undefined;
    if (!text) return { error: "say needs text (at most the chat's limit)" };
    const line = this.line(thread, lane, text, m.quiet === true ? { quiet: true } : {});
    await this.host.post(line);
    console.log(JSON.stringify({ msg: "debug.token-say", lane, owner: thread === OWNER_THREAD }));
    return { id: line.id };
  }

  private async ask(thread: string, lane: string, m: Record<string, unknown>) {
    const r = parseAsk(m, this.host.now(), () => crypto.randomUUID().slice(0, 12));
    if (!r.ok) return { error: r.error };
    const ask: Ask = r.ask;
    const text = laneText(lane, askText(ask)) ?? `【${lane}】`;
    const line = this.line(thread, lane, text, { ask });
    await this.host.post(line);
    console.log(
      JSON.stringify({
        msg: "debug.token-ask",
        lane,
        askId: ask.askId,
        owner: thread === OWNER_THREAD,
      }),
    );
    return { id: line.id, askId: ask.askId };
  }

  /** POST /api/version/chat. */
  async http(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ ok: false, error: "POST, or a WebSocket" }, 405);
    const m = /^Bearer (lk_[0-9a-f]{64})$/.exec(req.headers.get("authorization") ?? "");
    if (!m) return json({ ok: false, error: "Authorization: Bearer lk_… required" }, 401);
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ ok: false, error: "too large" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return json({ ok: false, error: "expected a JSON object" }, 400);
    }
    const op = body.op;
    if (op !== "say" && op !== "ask" && op !== "read")
      return json({ ok: false, error: 'op must be "say", "ask" or "read"' }, 400);
    const v = await this.check(op, { token: m[1] });
    if (!v.ok) return refusal(v);
    const thread = await this.threadOf(v);
    if (!thread) return json({ ok: false, error: "blocked" }, 403);
    if (op === "read") {
      const n = typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : 30;
      const list = (await this.host.history(thread)).slice(-Math.max(1, Math.min(MAX_READ, n)));
      return json({
        ok: true,
        thread: thread === OWNER_THREAD ? "owner" : "own",
        lane: v.lane,
        messages: list.map((x) => forLane(x, v.lane)),
      });
    }
    const out =
      op === "say" ? await this.say(thread, v.lane, body) : await this.ask(thread, v.lane, body);
    if ("error" in out) return json({ ok: false, error: out.error }, 400);
    return json({ ok: true, lane: v.lane, ...out });
  }

  /** A new socket at GET /api/version/chat (debug.ts has accepted it). */
  opened(ws: TokenSocket) {
    ws.serializeAttachment({ role: "token", at: this.host.now() } satisfies TokenAtt);
  }

  /** A message on a token socket. */
  async message(ws: TokenSocket, a: TokenAtt, raw: string | ArrayBuffer): Promise<void> {
    let m: Record<string, unknown> | null = null;
    if (typeof raw === "string" && raw.length <= MAX_BODY)
      try {
        const j = JSON.parse(raw) as unknown;
        if (j && typeof j === "object" && !Array.isArray(j)) m = j as Record<string, unknown>;
      } catch {}
    if (!a.thread) return this.auth(ws, a, m);
    if (!(await this.fresh(ws, a))) return;
    if (m?.type === "answer")
      return send(ws, {
        type: "error",
        error: "answers come only from a tap on a page; a token cannot answer",
      });
    if (m?.type !== "say" && m?.type !== "ask")
      return send(ws, {
        type: "error",
        error: 'a token socket sends only {"type":"say"} or {"type":"ask"}',
      });
    const v = await this.check(m.type, { tokenHash: a.hash! });
    if (!v.ok) {
      send(ws, {
        type: "error",
        error: v.error,
        ...(v.retryAfterMs ? { retryAfterMs: v.retryAfterMs } : {}),
      });
      if (v.error === "unknown" || v.error === "expired") close(ws, TOKEN_REFUSED, v.error);
      return;
    }
    const thread = await this.threadOf(v);
    // The thread is the one this socket authenticated for; an account cannot change hands.
    if (thread !== a.thread) return close(ws, TOKEN_REFUSED, "refused");
    const out =
      m.type === "say" ? await this.say(thread, v.lane, m) : await this.ask(thread, v.lane, m);
    if ("error" in out) return send(ws, { type: "error", error: out.error });
    send(ws, m.type === "say" ? { type: "sent", ...out } : { type: "asked", ...out });
  }

  private async auth(ws: TokenSocket, a: TokenAtt, m: Record<string, unknown> | null) {
    const t = this.host.now();
    if (t - a.at > AUTH_MS) return close(ws, TOKEN_REFUSED, "too slow");
    if (m?.type !== "auth" || typeof m.token !== "string" || !TOKEN_RE.test(m.token))
      return close(ws, TOKEN_REFUSED, 'first message: {"type":"auth","token":"lk_…"}');
    const v = await this.check("listen", { token: m.token });
    if (!v.ok) {
      send(ws, {
        type: "error",
        error: v.error,
        ...(v.retryAfterMs ? { retryAfterMs: v.retryAfterMs } : {}),
      });
      return close(ws, TOKEN_REFUSED, v.error);
    }
    const thread = await this.threadOf(v);
    if (!thread) {
      send(ws, { type: "error", error: "blocked" });
      return close(ws, TOKEN_REFUSED, "blocked");
    }
    const hash = v.id;
    const next: TokenAtt = {
      role: "token",
      at: a.at,
      thread,
      userId: v.userId,
      lane: v.lane,
      tag: v.tag,
      hash,
      until: v.expiresAt,
      checkedAt: t,
    };
    ws.serializeAttachment(next);
    // One token, a few sockets: the oldest goes.
    const same = this.authed().filter((s) => s.a.hash === hash && s.ws !== ws);
    for (const s of same
      .sort((x, y) => x.a.at - y.a.at)
      .slice(0, Math.max(0, same.length - MAX_SOCKETS_PER_TOKEN + 1)))
      close(s.ws, TOKEN_REPLACED, "a newer socket for this token");
    send(ws, {
      type: "ready",
      lane: v.lane,
      thread: thread === OWNER_THREAD ? "owner" : "own",
      until: v.expiresAt,
    });
    const n =
      typeof m.history === "number" && Number.isInteger(m.history)
        ? Math.min(MAX_READ, m.history)
        : 0;
    if (n > 0)
      send(ws, {
        type: "history",
        messages: (await this.host.history(thread)).slice(-n).map((x) => forLane(x, v.lane)),
      });
    console.log(JSON.stringify({ msg: "debug.token-listen", lane: v.lane, owner: v.owner }));
  }

  /** The authenticated token sockets (closing ones left out). */
  private authed(thread?: string) {
    const out: { ws: TokenSocket; a: TokenAtt }[] = [];
    for (const ws of this.host.sockets()) {
      if (ws.readyState !== undefined && ws.readyState > 1) continue;
      const a = tokenAtt(ws);
      if (a?.thread && (thread === undefined || a.thread === thread)) out.push({ ws, a });
    }
    return out;
  }

  /** How many token sockets listen in this thread (the pages' "agent listening"). */
  count(thread: string): number {
    return this.authed(thread).length;
  }

  /**
   * Is this socket's token still good? Expired: closed. Not checked for
   * RECHECK_MS: asked again; refused: closed; no answer: not delivered to now.
   */
  private async fresh(ws: TokenSocket, a: TokenAtt): Promise<boolean> {
    const t = this.host.now();
    if (a.until && a.until <= t) {
      send(ws, { type: "expired" });
      close(ws, TOKEN_REFUSED, "token expired");
      return false;
    }
    if (t - (a.checkedAt ?? 0) < RECHECK_MS) return true;
    const v = await this.check("recheck", { tokenHash: a.hash! });
    if (v.ok && v.userId === a.userId) {
      ws.serializeAttachment({ ...a, checkedAt: t, until: v.expiresAt } satisfies TokenAtt);
      return true;
    }
    if (!v.ok && (v.error === "unavailable" || v.error === "rate")) return false;
    send(ws, { type: "revoked" });
    close(ws, TOKEN_REFUSED, "token refused");
    return false;
  }

  /** A chat line was posted in `m.thread`: that thread's token sockets hear it. */
  async chat(m: ChatMessage & { thread: string }) {
    // Sockets that never sent their token are closed on the way.
    const t = this.host.now();
    for (const ws of this.host.sockets()) {
      const a = tokenAtt(ws);
      if (a && !a.thread && t - a.at > AUTH_MS) close(ws, TOKEN_REFUSED, "too slow");
    }
    await Promise.all(
      this.authed(m.thread).map(async ({ ws, a }) => {
        if (await this.fresh(ws, a)) send(ws, { type: "chat", message: forLane(m, a.lane) });
      }),
    );
  }

  /** An owner line was polished: the owner thread's token sockets hear it, as listeners do. */
  async edited(out: EditedEvent) {
    await Promise.all(
      this.authed(OWNER_THREAD).map(async ({ ws, a }) => {
        if (await this.fresh(ws, a)) send(ws, out);
      }),
    );
  }

  /** A tap answered `line` in `thread`: only a token ask's own lane hears it. */
  async answered(thread: string, line: ChatMessage, out: unknown) {
    if (line.via !== "token" || !line.lane) return;
    await Promise.all(
      this.authed(thread)
        .filter(({ a }) => a.lane === line.lane)
        .map(async ({ ws, a }) => {
          if (await this.fresh(ws, a)) send(ws, out);
        }),
    );
  }

  /** POST /internal/chat-tokens/revoked {tags?, userId?}: those tokens' sockets close now. */
  async revoked(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { tags?: unknown; userId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{16}$/.test(x))
      : [];
    const user = isUserId(body.userId) ? body.userId : undefined;
    if (!tags.length && !user) return json({ error: "expected {tags} or {userId}" }, 400);
    let closed = 0;
    for (const { ws, a } of this.authed()) {
      if ((a.tag && tags.includes(a.tag)) || (user && a.userId === user)) {
        send(ws, { type: "revoked" });
        close(ws, TOKEN_REFUSED, "token revoked");
        closed++;
      }
    }
    console.log(JSON.stringify({ msg: "debug.token-revoked", tags: tags.length, closed }));
    return json({ ok: true, closed });
  }
}

function refusal(v: { error: string; retryAfterMs?: number }): Response {
  const status = STATUS[v.error] ?? 503;
  const retry = v.retryAfterMs
    ? { "retry-after": String(Math.ceil(v.retryAfterMs / 1000)) }
    : undefined;
  return json({ ok: false, error: v.error }, status, retry);
}
