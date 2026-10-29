/**
 * The remote-eval and chat hub (docs/monitoring.md, "Remote eval (owner
 * debug)", "Chat with the agent" and "Friends").
 *
 * Two kinds of socket meet here, both held with the hibernation API (all
 * state lives in each socket's attachment, so eviction loses nothing):
 *
 *   page        A signed-in user's page in debug mode (app/components/DebugEval.tsx).
 *               index.ts has already asked the main Worker who it is and
 *               passes that on (x-debug-user/-email/-owner). Each page
 *               belongs to a thread: "owner" for the owner's pages, the
 *               user id for anyone else (a "friend").
 *   controller  The sender (scripts/dev/eval.ts). Unauthenticated, so it can
 *               do nothing until approved on a page: the hub shows a prompt
 *               with the controller's label and a short code the CLI prints
 *               too. "Allow" lets it send code for APPROVAL_MS; "Deny", "End"
 *               or the time running out close it.
 *
 * Audiences. Every pairing is for one audience: the owner (a plain pairing)
 * or one friend (`?for=<email>`, which only an owner-approved chat grant may
 * ask for). Its prompt shows only on that audience's pages, only those pages
 * may answer it, and its evals reach only those pages. So the owner's
 * approval never reaches a friend's device, and a friend's never the owner's.
 *
 * One pairing may wait per audience at a time (PENDING_MS at most), so
 * prompts cannot be spammed. No timers and no polling: expiry is checked
 * whenever the next event arrives, and the CLI gives up on its own clock.
 *
 * Page moves. A page that navigates client-side (the socket outlives it)
 * sends {type:"page", label}; the hub relabels that socket alone — later
 * chat, eval targets and listings use the new path — and tells the listeners
 * {type:"page-changed", label, thread, at}. Not stored, never in the chat.
 *
 * Heartbeat. An owner-approved controller sends {type:"busy", to?} while
 * the agent works on a message; the hub passes {type:"busy", label, at}
 * to that one thread's pages (the owner's by default) and acks {type:"beat"}.
 * Nothing is stored: the page's spinner times out on its own.
 *
 * Chat. A page sends {type:"chat", id, text}; an owner-approved controller
 * sends {type:"say", text, to?}. Each becomes a ChatMessage in its thread
 * (the last CHAT_HISTORY per thread, one storage key each), sent to that
 * thread's pages and to every owner-approved controller in time — which hear
 * every thread. A page gets its own thread's history on connect, never
 * another's. Friends chat without approval, at most FRIEND_CHAT_MAX messages
 * per FRIEND_CHAT_WINDOW_MS; the owner can Block one (/dev/friends →
 * /internal/friends), which closes their sockets and refuses them after.
 *
 * "Allow chat for 30 days" approves with scope "chat" (no eval) and hands the
 * controller a random grant token; only its SHA-256 is stored
 * (`grant:<hash>`), and reconnecting with it (header x-debug-token) restores
 * the scope without a prompt until it expires or "End" revokes it.
 */
import {
  APPROVAL_MS,
  CHAT_HISTORY,
  CHAT_MS,
  type ChatMessage,
  FRIEND_CHAT_MAX,
  FRIEND_CHAT_WINDOW_MS,
  type FriendRecord,
  type HubState,
  type Identity,
  MAX_LABEL,
  OWNER_THREAD,
  PAGE_ENDED,
  PENDING_MS,
  type PairInfo,
  type Scope,
  cleanLabel,
  isPageId,
  isUserId,
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
/**
 * `thread` is "owner" or the friend's user id; `email` is the friend's. `id`
 * names the socket in the chat menu's page list; `at` is when it connected.
 * (Sockets from before the list have neither: listed without an End.)
 */
type PageAtt = {
  role: "page";
  label: string;
  thread: string;
  email?: string;
  id?: string;
  at?: number;
};
/**
 * `grant` is the hash of the resumable chat token this socket holds, if any.
 * `forUser`/`forEmail`: the friend this pairing is for; absent = the owner.
 */
type ControllerAtt = {
  role: "controller";
  grant?: string;
  /** Approved for these page ids only ("Authorize this page"); absent = all. */
  pages?: string[];
  forUser?: string;
  forEmail?: string;
} & PairInfo;
/** `pages`: the owner's page ids it reaches (absent = all). */
type Grant = { label: string; until: number; pages?: string[] };
/** A friend's chat rate window. */
type Rate = { start: number; count: number };
/** The header a controller resumes its chat grant with. */
const TOKEN_HEADER = "x-debug-token";
/** Who a page is: set by index.ts from the main Worker's answer, never by the page. */
export const IDENTITY_HEADERS = {
  user: "x-debug-user",
  email: "x-debug-email",
  owner: "x-debug-owner",
} as const;
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
/** A pairing as pages see it: `scope` is what was granted, or (pending) what is asked for. */
const info = ({ pair, code, label, at, until, scope, pages }: ControllerAtt): PairInfo =>
  until
    ? { pair, code, label, at, until, scope: scope ?? "eval", ...(pages ? { pages } : {}) }
    : { pair, code, label, at, scope: scope ?? "eval" };
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const hashToken = async (token: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const head = (text: string) => text.slice(0, 80);
/** Whose a socket is: a page's thread, or the audience a controller was paired for. */
const audience = (a: Att) => (a.role === "page" ? a.thread : (a.forUser ?? OWNER_THREAD));

/**
 * A thread's storage keys. The owner's keep the keys from before threads
 * (`seq`, `msg:<seq>`), so its history carries over; a friend's live under
 * `t:<userId>:` (user ids have no ":", so no prefix holds another's).
 */
const threadKeys = (thread: string) =>
  thread === OWNER_THREAD
    ? { seq: "seq", prefix: "msg:" }
    : { seq: `t:${thread}:seq`, prefix: `t:${thread}:msg:` };
const msgKey = (thread: string, seq: number) =>
  `${threadKeys(thread).prefix}${String(seq).padStart(12, "0")}`;
const friendKey = (userId: string) => `friend:${userId}`;

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

  /** The pages of one thread. */
  private pages(thread: string, except?: Socket) {
    return this.sockets("page", except).filter((p) => p.a.thread === thread);
  }

  /**
   * The pages of `thread` a controller reaches live: all of them, unless it
   * was authorized for some pages only and this is its own audience's thread.
   */
  private reach(c: ControllerAtt, thread: string) {
    const all = this.pages(thread);
    if (!c.pages || thread !== audience(c)) return all;
    return all.filter((p) => p.a.id && c.pages?.includes(p.a.id));
  }

  /** What one audience's pages see: its own pairings, and how many agents listen. */
  private state(who: string, except?: Socket): HubState {
    const t = this.now();
    let pending: PairInfo | null = null;
    const sessions: PairInfo[] = [];
    for (const { a } of this.sockets("controller", except)) {
      if (audience(a) !== who) continue;
      if (a.until) {
        if (a.until > t) sessions.push(info(a));
      } else if (t - a.at < PENDING_MS) pending = info(a);
    }
    const pages = this.pages(who, except).map(({ a }) => ({
      id: a.id ?? "",
      label: a.label,
      at: a.at ?? 0,
    }));
    return { type: "state", pending, sessions, listeners: this.listeners(except).length, pages };
  }

  /** Every page its audience's state, each told which page it is. */
  private broadcast(except?: Socket) {
    const by = new Map<string, HubState>();
    for (const { ws, a } of this.sockets("page", except)) {
      let s = by.get(a.thread);
      if (!s) by.set(a.thread, (s = this.state(a.thread, except)));
      send(ws, { ...s, self: a.id });
    }
  }

  private controller(pair: string) {
    return this.sockets("controller").find((c) => c.a.pair === pair);
  }

  /**
   * Owner-approved controllers still in time: the agent. They hear every
   * thread and may `say` to any. A pairing made for a friend is not one.
   */
  private listeners(except?: Socket) {
    const t = this.now();
    return this.sockets("controller", except).filter(
      (c) => !c.a.forUser && c.a.until && c.a.until > t,
    );
  }

  /** One thread's kept chat, oldest first. */
  async history(thread: string = OWNER_THREAD): Promise<ChatMessage[]> {
    const m = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(thread).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    return [...m.values()].reverse().map((x) => ({ thread, ...x }));
  }

  /** Keep one chat message (dropping its thread's oldest past CHAT_HISTORY) and send it on. */
  private async post(m: ChatMessage & { thread: string }, only?: string[]) {
    const { seq: seqKey } = threadKeys(m.thread);
    const seq = ((await this.ctx.storage.get<number>(seqKey)) ?? 0) + 1;
    await this.ctx.storage.put(seqKey, seq);
    await this.ctx.storage.put(msgKey(m.thread, seq), m);
    if (seq > CHAT_HISTORY) await this.ctx.storage.delete(msgKey(m.thread, seq - CHAT_HISTORY));
    const out = { type: "chat", message: m };
    for (const { ws, a } of this.pages(m.thread))
      if (!only || (a.id && only.includes(a.id))) send(ws, out);
    for (const { ws } of this.listeners()) send(ws, out);
  }

  /** Everyone who has used the chat, most recent first. */
  async friends(): Promise<({ userId: string } & FriendRecord)[]> {
    const m = await this.ctx.storage.list<FriendRecord>({ prefix: "friend:" });
    return [...m.entries()]
      .map(([k, v]) => ({ userId: k.slice("friend:".length), ...v }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** A friend by user id or (any case) email. */
  private async findFriend(key: string) {
    if (isUserId(key)) {
      const rec = await this.ctx.storage.get<FriendRecord>(friendKey(key));
      if (rec) return { userId: key, ...rec };
    }
    const want = key.trim().toLowerCase();
    return (await this.friends()).find((f) => f.email.toLowerCase() === want);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/internal/friends")) return this.friendsApi(req, url);
    const control = url.pathname.endsWith("/control");
    let who: Identity | undefined;
    if (!control) {
      // Fail closed: a page with no identity from index.ts is nobody.
      const h = req.headers;
      const userId = h.get(IDENTITY_HEADERS.user) ?? "";
      const owner = h.get(IDENTITY_HEADERS.owner) === "1";
      if (!owner && !isUserId(userId)) return new Response("forbidden", { status: 403 });
      who = { userId, email: h.get(IDENTITY_HEADERS.email) ?? "", owner };
    }
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    if (control) await this.connectController(ws, url, req.headers.get(TOKEN_HEADER));
    else await this.connectPage(ws, url, who);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /**
   * The owner's friends API, reached only over the main Worker's PUSH binding
   * (index.ts answers /internal/* on the binding's hostname alone):
   *   GET  /internal/friends                → {friends}
   *   GET  /internal/friends/thread?user=id → {messages}  (the owner's read-only view)
   *   POST /internal/friends {userId, action: "block" | "unblock"}
   */
  private async friendsApi(req: Request, url: URL): Promise<Response> {
    if (req.method === "GET" && url.pathname.endsWith("/thread")) {
      const user = url.searchParams.get("user");
      if (!isUserId(user)) return Response.json({ error: "bad user" }, { status: 400 });
      return Response.json({ messages: await this.history(user) });
    }
    if (req.method === "GET") return Response.json({ friends: await this.friends() });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { userId?: unknown; action?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }
    if (!isUserId(body.userId) || (body.action !== "block" && body.action !== "unblock"))
      return Response.json({ error: "expected {userId, action: block|unblock}" }, { status: 400 });
    const rec = await this.block(body.userId, body.action === "block");
    if (!rec) return Response.json({ error: "no such chat user" }, { status: 404 });
    return Response.json({ ok: true, friend: { userId: body.userId, ...rec } });
  }

  /** Block (or unblock) a friend: blocking closes their pages and every pairing made for them. */
  async block(userId: string, blocked: boolean): Promise<FriendRecord | null> {
    const rec = await this.ctx.storage.get<FriendRecord>(friendKey(userId));
    if (!rec) return null;
    const next: FriendRecord = blocked
      ? { ...rec, blocked: true, blockedAt: this.now() }
      : { ...rec, blocked: false };
    await this.ctx.storage.put(friendKey(userId), next);
    console.log(JSON.stringify({ msg: blocked ? "debug.block" : "debug.unblock", userId }));
    if (!blocked) return next;
    for (const p of this.pages(userId)) {
      send(p.ws, { type: "friend-status", status: "blocked" });
      close(p.ws, 4403, "blocked");
    }
    for (const c of this.sockets("controller"))
      if (c.a.forUser === userId) {
        send(c.ws, { type: "revoked" });
        close(c.ws, 4401, "revoke");
      }
    this.broadcast();
    return next;
  }

  /**
   * A page joins (index.ts has checked who it is): it gets its own thread's
   * history and its audience's state. A blocked friend is told and closed.
   * Called without an identity (the unit tests' shorthand) it is an owner page.
   */
  async connectPage(ws: Socket, url: URL, who?: Identity) {
    const label = cleanLabel(url.searchParams.get("label"), MAX_LABEL);
    // The tab's own id (kept across reloads), so "this page" grants survive them.
    const tab = url.searchParams.get("tab");
    const id = isPageId(tab) ? tab : crypto.randomUUID().slice(0, 8);
    if (who && !who.owner) {
      if (!isUserId(who.userId)) return close(ws, 4403, "no identity");
      const rec = await this.ctx.storage.get<FriendRecord>(friendKey(who.userId));
      if (rec?.blocked) {
        send(ws, { type: "friend-status", status: "blocked" });
        return close(ws, 4403, "blocked");
      }
      ws.serializeAttachment({
        role: "page",
        label,
        thread: who.userId,
        email: cleanLabel(who.email, 320),
        id,
        at: this.now(),
      } satisfies PageAtt);
      send(ws, { type: "friend-status", status: "open" });
    } else
      ws.serializeAttachment({
        role: "page",
        label,
        thread: OWNER_THREAD,
        id,
        at: this.now(),
      } satisfies PageAtt);
    const thread = audience(att(ws) as PageAtt);
    // Everyone sees the new page in their list; this one gets its state first.
    send(ws, { ...this.state(thread), self: id });
    send(ws, { type: "history", messages: await this.history(thread) });
    this.broadcast(ws);
  }

  /**
   * A controller knocks. `?for=<email>` asks a friend's pages for an eval
   * pairing, and only an owner-approved grant may ask. With just a grant
   * token it is back in chat scope at once. Otherwise it waits for the
   * owner: one pending pairing per audience, and only with a page to ask.
   * `?scope=chat` asks for the 30-day chat grant; anything else for eval
   * (and chat) for an hour. Allow grants exactly what was asked.
   */
  async connectController(ws: Socket, url: URL, token?: string | null) {
    const forKey = url.searchParams.get("for")?.trim();
    if (forKey) return this.pairForFriend(ws, url, forKey, token);
    if (token) return this.resume(ws, url, token);
    const label = cleanLabel(url.searchParams.get("label"), 80) || "unnamed controller";
    if (!this.clearPending(ws, OWNER_THREAD)) return;
    if (this.pages(OWNER_THREAD, ws).length === 0) {
      send(ws, { type: "error", error: "no owner page in debug mode is open" });
      return close(ws, 4404, "no debug page");
    }
    const scope = url.searchParams.get("scope") === "chat" ? "chat" : "eval";
    this.knock(ws, { label, scope });
  }

  /** Make room for one audience's pairing: false (and `ws` closed) if one is still waiting. */
  private clearPending(ws: Socket, who: string) {
    const t = this.now();
    for (const c of this.sockets("controller", ws)) {
      if (c.a.until || audience(c.a) !== who) continue;
      if (t - c.a.at < PENDING_MS) {
        send(ws, { type: "error", error: "another pairing request is waiting for an answer" });
        close(ws, 4429, "pairing busy");
        return false;
      }
      send(c.ws, { type: "expired" });
      close(c.ws, 4408, "pairing expired");
    }
    return true;
  }

  private knock(
    ws: Socket,
    extra: { label: string; scope: Scope; forUser?: string; forEmail?: string },
  ) {
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      at: this.now(),
      ...extra,
    };
    ws.serializeAttachment(a);
    send(ws, { type: "pending", code: a.code, expiresIn: PENDING_MS, for: a.forEmail });
    console.log(
      JSON.stringify({
        msg: "debug.pair",
        pair: a.pair,
        code: a.code,
        label: a.label,
        scope: a.scope,
        for: a.forUser,
      }),
    );
    this.broadcast();
  }

  /** The owner's live grant behind a token, or null (and a lapsed one deleted). */
  private async liveGrant(token: string) {
    const hash = await hashToken(token.slice(0, 256));
    const g = await this.ctx.storage.get<Grant>(`grant:${hash}`);
    if (g && g.until > this.now()) return { hash, g };
    if (g) await this.ctx.storage.delete(`grant:${hash}`);
    return null;
  }

  /**
   * An eval pairing on one friend's pages. Only the owner's agent (a live
   * chat grant) may ask; the friend answers on their own device.
   */
  private async pairForFriend(ws: Socket, url: URL, key: string, token?: string | null) {
    const live = token ? await this.liveGrant(token) : null;
    if (!live) {
      send(ws, { type: "error", error: "pairing with a friend needs the owner's chat grant" });
      return close(ws, 4498, "grant invalid");
    }
    const f = await this.findFriend(key);
    if (!f || f.blocked) {
      send(ws, { type: "error", error: `no chat user ${key} (or blocked)` });
      return close(ws, 4404, "no such friend");
    }
    if (!this.clearPending(ws, f.userId)) return;
    if (this.pages(f.userId, ws).length === 0) {
      send(ws, { type: "error", error: `no debug page of ${f.email} is open` });
      return close(ws, 4404, "no debug page");
    }
    this.knock(ws, {
      label: cleanLabel(url.searchParams.get("label"), 80) || live.g.label,
      scope: "eval",
      forUser: f.userId,
      forEmail: f.email,
    });
  }

  /** Reconnecting with a grant token: chat scope again, no prompt — or 4498 if it is not live. */
  private async resume(ws: Socket, url: URL, token: string) {
    const live = await this.liveGrant(token);
    if (!live) {
      send(ws, { type: "error", error: "chat grant is not valid (expired or ended)" });
      return close(ws, 4498, "grant invalid");
    }
    const { hash, g } = live;
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      label: cleanLabel(url.searchParams.get("label"), 80) || g.label,
      at: this.now(),
      until: g.until,
      scope: "chat",
      grant: hash,
      pages: g.pages,
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
    if (m.type === "page") {
      // Only this socket's own label; silent: the agent hears it, the chat never shows it.
      if (m.label === page.label) return;
      ws.serializeAttachment({ ...page, label: m.label } satisfies PageAtt);
      const moved = {
        type: "page-changed",
        label: m.label,
        thread: page.thread,
        ...(page.email ? { email: page.email } : {}),
        at: t,
      };
      for (const { ws: c } of this.listeners()) send(c, moved);
      return this.broadcast();
    }
    if (m.type === "end-page") {
      // Only a page of the same audience (the owner's own, or this friend's own).
      const target = this.pages(page.thread).find((p) => p.a.id && p.a.id === m.id);
      if (!target) return send(ws, this.state(page.thread));
      send(target.ws, { type: "page-ended" });
      close(target.ws, PAGE_ENDED, "ended from another page");
      console.log(
        JSON.stringify({ msg: "debug.end-page", thread: page.thread, page: target.a.label }),
      );
      return this.broadcast(target.ws);
    }
    if (m.type === "chat") {
      console.log(
        JSON.stringify({
          msg: "debug.chat",
          page: page.label,
          thread: page.thread,
          len: m.text.length,
          head: head(m.text),
        }),
      );
      if (page.thread !== OWNER_THREAD) return this.friendChat(ws, page, m.id, m.text);
      return this.post({
        id: m.id,
        from: "owner",
        label: page.label,
        text: m.text,
        at: t,
        thread: OWNER_THREAD,
      });
    }
    // Only a pairing made for this page's own audience can be answered or sent results.
    const c = this.controller(m.type === "result" ? m.to : m.pair);
    if (!c || audience(c.a) !== page.thread) return send(ws, this.state(page.thread));
    if (m.type === "allow") {
      const pages = this.grantPages(page, m.pages);
      // Approved already: another page joins its grant ("Authorize this page" later).
      if (c.a.until && c.a.until > t) return this.widen(c.a, pages);
      if (c.a.until || t - c.a.at >= PENDING_MS) return send(ws, this.state(page.thread));
      // Allow grants what the requester asked for (`scope` from an older page
      // still counts). A friend's answer is always eval on their own pages.
      return (c.a.scope === "chat" || m.scope === "chat") && !c.a.forUser
        ? this.allowChat(c.ws, c.a, pages)
        : this.allowEval(c.ws, c.a, pages);
    }
    if (m.type === "deny" || m.type === "revoke") return this.end(m.type, c.ws, c.a);
    // A result goes back only to an approved controller that is still in time.
    if (m.type !== "result" || !c.a.until || c.a.until <= t) return;
    const { type: _t, to: _to, ...rest } = m;
    send(c.ws, { type: "result", ...rest, page: page.label });
  }

  /**
   * A friend's message: no approval needed, but a blocked friend is closed
   * and more than FRIEND_CHAT_MAX in a window is dropped (and the page told).
   * Their first ever message tells the agent ({type:"friend-new"}).
   */
  private async friendChat(ws: Socket, page: PageAtt, id: string, text: string) {
    const t = this.now();
    const userId = page.thread;
    const rec = await this.ctx.storage.get<FriendRecord>(friendKey(userId));
    if (rec?.blocked) {
      send(ws, { type: "friend-status", status: "blocked" });
      return close(ws, 4403, "blocked");
    }
    const rateKey = `rate:${userId}`;
    let rate = (await this.ctx.storage.get<Rate>(rateKey)) ?? { start: t, count: 0 };
    if (t - rate.start >= FRIEND_CHAT_WINDOW_MS) rate = { start: t, count: 0 };
    if (rate.count >= FRIEND_CHAT_MAX)
      return send(ws, {
        type: "rate-limited",
        id,
        retryIn: rate.start + FRIEND_CHAT_WINDOW_MS - t,
      });
    await this.ctx.storage.put(rateKey, {
      start: rate.start,
      count: rate.count + 1,
    } satisfies Rate);
    const email = rec?.email || page.email || "";
    await this.ctx.storage.put(friendKey(userId), {
      ...(rec ?? { firstSeen: t }),
      email,
      lastAt: t,
      count: (rec?.count ?? 0) + 1,
    } satisfies FriendRecord);
    if (!rec) {
      console.log(JSON.stringify({ msg: "debug.friend-new", userId, email }));
      for (const l of this.listeners()) send(l.ws, { type: "friend-new", userId, email, at: t });
    }
    return this.post({ id, from: "friend", label: page.label, text, at: t, thread: userId, email });
  }

  /**
   * The page ids an Allow covers: "all" (or nothing said, from an older page)
   * is undefined = every page, now and later; a list keeps only this
   * audience's open pages, and never comes out empty (at least the answering one).
   */
  private grantPages(page: PageAtt, want: string[] | "all" | undefined) {
    if (want === undefined || want === "all") return undefined;
    const open = new Set(this.pages(page.thread).map((p) => p.a.id));
    const ids = want.filter((id) => open.has(id));
    return ids.length ? [...new Set(ids)] : page.id ? [page.id] : undefined;
  }

  /** Add pages to an approved pairing (and every socket sharing its grant); undefined = all. */
  private async widen(a: ControllerAtt, pages: string[] | undefined) {
    if (!a.pages) return this.broadcast();
    const next = pages ? [...new Set([...a.pages, ...pages])] : undefined;
    const targets = this.sockets("controller").filter((c) =>
      a.grant ? c.a.grant === a.grant : c.a.pair === a.pair,
    );
    for (const c of targets)
      c.ws.serializeAttachment({ ...c.a, pages: next } satisfies ControllerAtt);
    if (a.grant) {
      const g = await this.ctx.storage.get<Grant>(`grant:${a.grant}`);
      if (g) await this.ctx.storage.put(`grant:${a.grant}`, { ...g, pages: next } satisfies Grant);
    }
    console.log(JSON.stringify({ msg: "debug.widen", pair: a.pair, pages: next ?? "all" }));
    this.broadcast();
  }

  /** "Allow" for eval: code (and, for the owner, chat) for an hour, on this socket only. */
  private allowEval(ws: Socket, a: ControllerAtt, pages?: string[]) {
    const until = this.now() + APPROVAL_MS;
    ws.serializeAttachment({ ...a, until, scope: "eval", pages } satisfies ControllerAtt);
    send(ws, { type: "approved", until, scope: "eval", for: a.forEmail });
    console.log(
      JSON.stringify({ msg: "debug.allow", pair: a.pair, label: a.label, until, for: a.forUser }),
    );
    this.broadcast();
    // A pairing for a friend is eval only: it is handed no chat.
    if (a.forUser) return;
    return this.history().then((messages) => send(ws, { type: "history", messages }));
  }

  /** "Allow" for chat: 30 days, with a grant token the controller can resume with. */
  private async allowChat(ws: Socket, a: ControllerAtt, pages?: string[]) {
    const until = this.now() + CHAT_MS;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const grant = await hashToken(token);
    await this.ctx.storage.put(`grant:${grant}`, { label: a.label, until, pages } satisfies Grant);
    ws.serializeAttachment({ ...a, until, scope: "chat", grant, pages } satisfies ControllerAtt);
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

  /** Where an agent's `say` goes: the owner's thread, or a friend's by user id or email. */
  private async sayTarget(
    to?: string,
  ): Promise<{ thread: string; email?: string } | { error: string }> {
    if (!to || to === OWNER_THREAD) return { thread: OWNER_THREAD };
    const f = await this.findFriend(to);
    if (!f) return { error: `no chat thread for ${to}` };
    if (f.blocked) return { error: `${f.email} is blocked` };
    return { thread: f.userId, email: f.email };
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
    if (m.value.type === "busy") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      const { to, label } = m.value;
      return this.sayTarget(to).then((dest) => {
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        // Only that thread's pages; not stored, not logged (one every few seconds).
        const pages = this.reach(c, dest.thread);
        const beat = { type: "busy", label: label || c.label, at: t };
        for (const { ws: p } of pages) send(p, beat);
        send(ws, { type: "beat", thread: dest.thread, delivered: pages.length, at: t });
      });
    }
    if (m.value.type === "say") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      const { text, to } = m.value;
      return this.sayTarget(to).then((dest) => {
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        const said: ChatMessage & { thread: string } = {
          id: crypto.randomUUID().slice(0, 8),
          from: "agent",
          label: c.label,
          text,
          at: t,
          ...dest,
        };
        console.log(
          JSON.stringify({
            msg: "debug.say",
            pair: c.pair,
            controller: c.label,
            thread: said.thread,
            len: text.length,
            head: head(text),
          }),
        );
        return this.post(said, said.thread === audience(c) ? c.pages : undefined).then(() =>
          send(ws, { type: "said", id: said.id, thread: said.thread }),
        );
      });
    }
    if (c.scope === "chat")
      return send(ws, { type: "error", error: "this session is chat-only: it cannot eval" });
    const id = crypto.randomUUID().slice(0, 8);
    const labels: string[] = [];
    // Only the pages of the audience that approved this pairing — or the ones it named.
    const reach = this.reach(c, audience(c));
    if (c.pages && reach.length === 0) {
      send(ws, { type: "error", error: "the page you were authorized for is gone: pair again" });
      close(ws, 4404, "authorized page gone");
      return this.broadcast(ws);
    }
    for (const p of reach) {
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
        for: c.forUser,
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
    // A page leaving changes its audience's page list; a controller, the sessions.
    this.broadcast(ws);
  }
}
