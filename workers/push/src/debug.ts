/**
 * The owner's remote-eval hub (docs/monitoring.md, "Remote eval (owner debug)").
 *
 * Two kinds of socket meet here, both held with the hibernation API (all
 * state lives in each socket's attachment, so eviction loses nothing):
 *
 *   page        An owner page in debug mode (app/components/DebugEval.tsx).
 *               index.ts has already checked its cookie is the owner's.
 *   controller  The sender (scripts/dev/eval.ts). Unauthenticated, so it can
 *               do nothing until the owner approves it on a page: the hub
 *               shows every page a prompt with the controller's label and a
 *               short code the CLI prints too. "Allow" lets it send code for
 *               APPROVAL_MS; "Deny", "End" or the time running out close it.
 *
 * One pairing may wait at a time (PENDING_MS at most), so prompts cannot be
 * spammed. No timers and no polling: expiry is checked whenever the next
 * event arrives, and the CLI gives up on its own clock.
 *
 * Chat: a page sends {type:"chat", id, text}; an approved controller sends
 * {type:"say", text}. Each becomes a ChatMessage, kept (the last
 * CHAT_HISTORY, one storage key each) and broadcast to every page and every
 * approved controller. A page gets the history on connect, a controller on
 * approval. "Allow chat for 30 days" approves with scope "chat" (no eval) and
 * hands the controller a random grant token; only its SHA-256 is stored
 * (`grant:<hash>`), and reconnecting with it (header x-debug-token) restores
 * the scope without a prompt until it expires or "End" revokes it.
 */
import {
  APPROVAL_MS,
  CHAT_HISTORY,
  CHAT_MS,
  type ChatMessage,
  type HubState,
  MAX_LABEL,
  PENDING_MS,
  type PairInfo,
  cleanLabel,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  shortCode,
} from "../../../lib/dev-eval";

export type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
export type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>;
};
export type DebugState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: Storage;
};
type PageAtt = { role: "page"; label: string };
/** `grant` is the hash of the resumable chat token this socket holds, if any. */
type ControllerAtt = { role: "controller"; grant?: string } & PairInfo;
type Grant = { label: string; until: number };
/** The header a controller resumes its chat grant with. */
const TOKEN_HEADER = "x-debug-token";
type Att = PageAtt | ControllerAtt;
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

const att = (ws: Socket): Att | null => {
  try {
    return (ws.deserializeAttachment() as Att | null) ?? null;
  } catch {
    return null;
  }
};
const send = (ws: Socket, msg: unknown) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
};
const close = (ws: Socket, code: number, reason: string) => {
  try {
    ws.close(code, reason);
  } catch {}
};
const info = ({ pair, code, label, at, until, scope }: ControllerAtt): PairInfo =>
  until ? { pair, code, label, at, until, scope: scope ?? "eval" } : { pair, code, label, at };
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const hashToken = async (token: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const msgKey = (seq: number) => `msg:${String(seq).padStart(12, "0")}`;
const head = (text: string) => text.slice(0, 80);

export class DebugHub {
  constructor(
    private ctx: DebugState,
    _env?: unknown,
    private now: () => number = Date.now,
  ) {}

  /** Open sockets of one role, optionally leaving one out (the one closing). */
  private sockets<R extends Att["role"]>(role: R, except?: Socket) {
    const out: { ws: Socket; a: Extract<Att, { role: R }> }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || (ws.readyState !== undefined && ws.readyState > 1)) continue;
      const a = att(ws);
      if (a?.role === role) out.push({ ws, a: a as Extract<Att, { role: R }> });
    }
    return out;
  }

  private state(except?: Socket): HubState {
    const t = this.now();
    let pending: PairInfo | null = null;
    const sessions: PairInfo[] = [];
    for (const { a } of this.sockets("controller", except)) {
      if (a.until) {
        if (a.until > t) sessions.push(info(a));
      } else if (t - a.at < PENDING_MS) pending = info(a);
    }
    return { type: "state", pending, sessions };
  }

  private broadcast(except?: Socket) {
    const s = this.state(except);
    for (const { ws } of this.sockets("page", except)) send(ws, s);
  }

  private controller(pair: string) {
    return this.sockets("controller").find((c) => c.a.pair === pair);
  }

  /** Approved controllers still in time: every one of them may chat. */
  private listeners(except?: Socket) {
    const t = this.now();
    return this.sockets("controller", except).filter((c) => c.a.until && c.a.until > t);
  }

  /** The kept chat, oldest first. */
  async history(): Promise<ChatMessage[]> {
    const m = await this.ctx.storage.list<ChatMessage>({
      prefix: "msg:",
      reverse: true,
      limit: CHAT_HISTORY,
    });
    return [...m.values()].reverse();
  }

  /** Keep one chat message (dropping the oldest past CHAT_HISTORY) and send it to everyone. */
  private async post(m: ChatMessage) {
    const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
    await this.ctx.storage.put("seq", seq);
    await this.ctx.storage.put(msgKey(seq), m);
    if (seq > CHAT_HISTORY) await this.ctx.storage.delete(msgKey(seq - CHAT_HISTORY));
    const out = { type: "chat", message: m };
    for (const { ws } of this.sockets("page")) send(ws, out);
    for (const { ws } of this.listeners()) send(ws, out);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    if (url.pathname.endsWith("/control"))
      await this.connectController(ws, url, req.headers.get(TOKEN_HEADER));
    else await this.connectPage(ws, url);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** An owner page (already authenticated by index.ts) joins: tell it the state and the chat so far. */
  async connectPage(ws: Socket, url: URL) {
    ws.serializeAttachment({
      role: "page",
      label: cleanLabel(url.searchParams.get("label"), MAX_LABEL),
    } satisfies PageAtt);
    send(ws, this.state());
    send(ws, { type: "history", messages: await this.history() });
  }

  /**
   * A controller knocks. With a live grant token it is back in chat scope at
   * once; otherwise one pending pairing at a time, and only with a page to ask.
   */
  async connectController(ws: Socket, url: URL, token?: string | null) {
    if (token) return this.resume(ws, url, token);
    const t = this.now();
    const label = cleanLabel(url.searchParams.get("label"), 80) || "unnamed controller";
    for (const c of this.sockets("controller", ws)) {
      if (c.a.until) continue;
      if (t - c.a.at < PENDING_MS) {
        send(ws, { type: "error", error: "another pairing request is waiting for an answer" });
        return close(ws, 4429, "pairing busy");
      }
      send(c.ws, { type: "expired" });
      close(c.ws, 4408, "pairing expired");
    }
    if (this.sockets("page", ws).length === 0) {
      send(ws, { type: "error", error: "no owner page in debug mode is open" });
      return close(ws, 4404, "no debug page");
    }
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      label,
      at: t,
    };
    ws.serializeAttachment(a);
    send(ws, { type: "pending", code: a.code, expiresIn: PENDING_MS });
    console.log(JSON.stringify({ msg: "debug.pair", pair: a.pair, code: a.code, label }));
    this.broadcast();
  }

  /** Reconnecting with a grant token: chat scope again, no prompt — or 4498 if it is not live. */
  private async resume(ws: Socket, url: URL, token: string) {
    const t = this.now();
    const hash = await hashToken(token.slice(0, 256));
    const g = await this.ctx.storage.get<Grant>(`grant:${hash}`);
    if (!g || g.until <= t) {
      if (g) await this.ctx.storage.delete(`grant:${hash}`);
      send(ws, { type: "error", error: "chat grant is not valid (expired or ended)" });
      return close(ws, 4498, "grant invalid");
    }
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      label: cleanLabel(url.searchParams.get("label"), 80) || g.label,
      at: t,
      until: g.until,
      scope: "chat",
      grant: hash,
    };
    ws.serializeAttachment(a);
    send(ws, { type: "approved", until: g.until, scope: "chat", resumed: true });
    send(ws, { type: "history", messages: await this.history() });
    console.log(JSON.stringify({ msg: "debug.resume", pair: a.pair, label: a.label }));
    this.broadcast();
  }

  webSocketMessage(ws: Socket, raw: string | ArrayBuffer): void | Promise<void> {
    const a = att(ws);
    if (a?.role === "page") return this.fromPage(ws, a, raw);
    if (a?.role === "controller") return this.fromController(ws, a, raw);
  }

  private fromPage(ws: Socket, page: PageAtt, raw: unknown): void | Promise<void> {
    const m = parsePageMessage(raw);
    if (!m) return;
    const t = this.now();
    if (m.type === "chat") {
      console.log(
        JSON.stringify({
          msg: "debug.chat",
          page: page.label,
          len: m.text.length,
          head: head(m.text),
        }),
      );
      return this.post({ id: m.id, from: "owner", label: page.label, text: m.text, at: t });
    }
    const c = this.controller(m.type === "result" ? m.to : m.pair);
    if (!c) return send(ws, this.state());
    if (m.type === "allow") {
      if (c.a.until || t - c.a.at >= PENDING_MS) return send(ws, this.state());
      return m.scope === "chat" ? this.allowChat(c.ws, c.a) : this.allowEval(c.ws, c.a);
    }
    if (m.type === "deny" || m.type === "revoke") return this.end(m.type, c.ws, c.a);
    // A result goes back only to an approved controller that is still in time.
    if (m.type !== "result" || !c.a.until || c.a.until <= t) return;
    const { type: _t, to: _to, ...rest } = m;
    send(c.ws, { type: "result", ...rest, page: page.label });
  }

  /** "Allow for 1 hour": eval and chat, for this socket only. */
  private allowEval(ws: Socket, a: ControllerAtt) {
    const until = this.now() + APPROVAL_MS;
    ws.serializeAttachment({ ...a, until, scope: "eval" } satisfies ControllerAtt);
    send(ws, { type: "approved", until, scope: "eval" });
    console.log(JSON.stringify({ msg: "debug.allow", pair: a.pair, label: a.label, until }));
    this.broadcast();
    return this.history().then((messages) => send(ws, { type: "history", messages }));
  }

  /** "Allow chat for 30 days": chat only, with a grant token the controller can resume with. */
  private async allowChat(ws: Socket, a: ControllerAtt) {
    const until = this.now() + CHAT_MS;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const grant = await hashToken(token);
    await this.ctx.storage.put(`grant:${grant}`, { label: a.label, until } satisfies Grant);
    ws.serializeAttachment({ ...a, until, scope: "chat", grant } satisfies ControllerAtt);
    send(ws, { type: "approved", until, scope: "chat", token });
    console.log(
      JSON.stringify({ msg: "debug.allow", pair: a.pair, label: a.label, until, scope: "chat" }),
    );
    this.broadcast();
    send(ws, { type: "history", messages: await this.history() });
  }

  /** Deny a pairing, or End a session — and with it the grant behind it, on every socket using it. */
  private end(kind: "deny" | "revoke", ws: Socket, a: ControllerAtt): void | Promise<void> {
    const targets = a.grant
      ? this.sockets("controller").filter((c) => c.a.grant === a.grant)
      : [{ ws, a }];
    for (const c of targets) {
      send(c.ws, { type: kind === "deny" ? "denied" : "revoked" });
      close(c.ws, kind === "deny" ? 4403 : 4401, kind);
    }
    console.log(JSON.stringify({ msg: `debug.${kind}`, pair: a.pair, label: a.label }));
    this.broadcast(ws);
    if (a.grant) return this.ctx.storage.delete(`grant:${a.grant}`).then(() => undefined);
  }

  private fromController(ws: Socket, c: ControllerAtt, raw: unknown): void | Promise<void> {
    const t = this.now();
    if (!c.until) return send(ws, { type: "error", error: "not approved yet" });
    if (c.until <= t) {
      send(ws, { type: "expired" });
      close(ws, 4408, "approval expired");
      return this.broadcast(ws);
    }
    const m = parseControllerMessage(raw);
    if (!m.ok) return send(ws, { type: "error", error: m.error });
    if (m.value.type === "say") {
      const said: ChatMessage = {
        id: crypto.randomUUID().slice(0, 8),
        from: "agent",
        label: c.label,
        text: m.value.text,
        at: t,
      };
      console.log(
        JSON.stringify({
          msg: "debug.say",
          pair: c.pair,
          controller: c.label,
          len: said.text.length,
          head: head(said.text),
        }),
      );
      return this.post(said).then(() => send(ws, { type: "said", id: said.id }));
    }
    if (c.scope === "chat")
      return send(ws, { type: "error", error: "this session is chat-only: it cannot eval" });
    const id = crypto.randomUUID().slice(0, 8);
    const labels: string[] = [];
    for (const p of this.sockets("page")) {
      if (!matchesTarget(p.a.label, m.value.target)) continue;
      send(p.ws, { type: "eval", id, code: m.value.code, to: c.pair });
      labels.push(p.a.label);
    }
    console.log(
      JSON.stringify({
        msg: "debug.eval",
        id,
        pair: c.pair,
        controller: c.label,
        len: m.value.code.length,
        target: m.value.target,
        head: m.value.code.slice(0, 200),
        delivered: labels.length,
      }),
    );
    send(ws, { type: "sent", id, delivered: labels.length, labels });
  }

  webSocketClose(ws: Socket, code: number) {
    close(ws, code === 1005 ? 1000 : code, "");
    if (att(ws)?.role === "controller") this.broadcast(ws);
  }
}
