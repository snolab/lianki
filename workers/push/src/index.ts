/**
 * lianki-push — the new-version notice, event-driven end to end
 * (app/components/VersionNotice.tsx is the page's side), and the owner's
 * remote-eval hub (debug.ts; app/components/DebugEval.tsx is the page).
 *
 *   GET  /api/version/ws?b=<the page's build>
 *                              WebSocket. On connect: {"build": "<id>"} —
 *                              the build serving now — and again whenever
 *                              a new one is published, with what changed
 *                              for that page's build: {shell, routes, force}
 *                              (smart refresh: lib/smart-refresh.ts).
 *   POST /internal/publish     The main Worker, over its service binding
 *                              (PUSH), on the first request a new isolate
 *                              serves: body = its build id, and its route
 *                              fingerprints in x-lk-fingerprints. A new build
 *                              is stored and pushed to every page; the same
 *                              one again does nothing.
 *   GET  /api/version/stream   The old SSE notice, for pages from before:
 *                              one "new version" event, then silence.
 *   GET  /api/version/debug    WebSocket for a signed-in user's debug-mode
 *                              pages (?label=<path + user agent>). Accepted
 *                              only from a lianki.com page whose cookie the
 *                              main Worker (service binding MAIN,
 *                              /api/debug/identity) names a user for; 403
 *                              otherwise. Who it is goes to the hub in the
 *                              x-debug-* headers, set here and nowhere else.
 *   GET  /api/version/debug/control
 *                              WebSocket for the sender (scripts/dev/eval.ts):
 *                              unauthenticated, and useless until the owner
 *                              allows it on one of those pages (debug.ts) —
 *                              or it presents a live grant (chat, or eval:
 *                              the page set comes back too) in the
 *                              x-debug-token header (or x-liagent-token, its
 *                              alias; both must match). The same sockets carry
 *                              the agent's side of the chat.
 *   GET  /api/version/progress WebSocket for the owner's /dev/roadmap: live
 *                              agent progress (progress.ts). The owner only,
 *                              checked as for the debug pages; 403 otherwise.
 *                              The owner's box: a box chat ticket instead,
 *                              from its own origin (progress.ts, "the box").
 *   POST /api/version/progress An agent's report (scripts/dev/progress.ts),
 *                              with Authorization: Bearer <PROGRESS_TOKEN>.
 *                              503 while that secret is unset.
 *   GET  /api/version/read-stream?book=<id>
 *                              WebSocket for an open reader following a live
 *                              Google Doc (read-stream.ts). The user's own hub,
 *                              named by the cookie, as for the debug pages.
 *   POST /internal/read-stream The main Worker, over its service binding: a
 *                              book of that user changed.
 *   GET/POST /internal/friends The main Worker's owner-only /api/dev/friends,
 *                              over its PUSH binding: list chat users, read
 *                              one's thread, Block or unblock (debug.ts).
 *   POST /api/version/chat     `lianki chat say|ask|read` with an API token
 *   GET  /api/version/chat     (Authorization: Bearer lk_…), or a WebSocket for
 *                              `lianki chat listen` (the token in its first
 *                              message). Only the token account's own thread
 *                              (token-chat.ts); no browser Origin.
 *   POST /internal/chat-tokens/revoked
 *                              The main Worker: those API tokens' listening
 *                              sockets close at once.
 *   POST /internal/box-closed  The main Worker, when a box loses box:chat
 *                              (removed or revoked): body {client}. That box's
 *                              chat sockets close (docs/box-oauth.md).
 *   POST /internal/signed-out  The main Worker, when a sign-in session is
 *                              deleted (sign-out): body {session: its tag}.
 *                              Every eval grant renewing on it stops at once.
 *   POST /internal/chat-backfill The main Worker's /api/chat/history, for the
 *                              owner: the owner thread's stored history into
 *                              the owners' accounts in D1, once (debug.ts).
 *
 * /internal/* is answered only on the binding's own hostname (lianki-push):
 * there is no workers.dev URL, and the zone route covers /api/version/* only.
 *
 * VersionHub holds the version sockets, DebugHub the debug ones, both with
 * the hibernation API: idle, they are evicted and the sockets cost nothing.
 * No timers, no polling.
 *
 * Types are declared here rather than taken from @cloudflare/workers-types:
 * the repo's root tsconfig type-checks this folder with the DOM lib.
 */
import {
  BOX_HEADER,
  DEBUG_ORIGIN,
  DEV_BRIDGE_HEADER,
  EMBED_HEADER,
  boxChatTicket,
  debugIdentity,
  offersPartner,
  partnerTicket,
} from "./auth";
import {
  FINGERPRINTS_HEADER,
  type RouteFingerprints,
  parseFingerprints,
  versionNews,
} from "../../../lib/smart-refresh";
import { explicitVersionNews } from "../../../lib/version-publish";
import { CHAT_BACKFILL_PATH, EVAL_TOKEN_HEADER, IDENTITY_HEADERS } from "./debug";
import { CHAT_PATH, REVOKED_PATH } from "./token-chat";
import { AVATAR_PATH } from "../../../packages/debug-chat/src/svg-avatar";
import {
  BOX_CLOSED_PATH,
  PROGRESS_BOX_HEADER,
  PROGRESS_OWNER_HEADER,
  PROGRESS_TICKET_HEADER,
  progressGate,
} from "./progress";

import { COLO_HEADER, STT_SIGNAL_PATH, STT_WORKER_PATH } from "./stt-registry";

export { DebugHub } from "./debug";
export { ProgressHub } from "./progress";
export { ReadStreamHub } from "./read-stream";
export { SttRegistry } from "./stt-registry";

type Socket = WebSocket & {
  accept?: () => void;
  serializeAttachment?(v: unknown): void;
  deserializeAttachment?(): unknown;
};
type State = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: {
    get<T>(k: string): Promise<T | undefined>;
    put(k: string, v: unknown): Promise<void>;
    delete?(k: string): Promise<unknown>;
  };
};
type Stub = { fetch(req: Request): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
export type Env = {
  HUB: Namespace;
  DEBUG: Namespace;
  /** Optional only so older test envs type-check; deployed, it is always bound. */
  PROGRESS?: Namespace;
  /** Optional only so older test envs type-check; deployed, it is always bound. */
  READ_STREAM?: Namespace;
  MAIN?: Fetcher;
  /** The main Worker's DebugSessions RPC entrypoint (worker.ts): is a session still live? */
  SESSIONS?: {
    live(user: string, session: string): Promise<unknown>;
    boxChat?(clientId: string): Promise<unknown>;
    flag?(key: string): Promise<unknown>;
    config?(key: string): Promise<unknown>;
    sttWorker?(pubkey: string): Promise<unknown>;
    bookStt?(userId: string, audioMs: number): Promise<unknown>;
  };
  /** Lianki's speech servers' registry (stt-registry.ts). Optional only so older test envs type-check. */
  STT?: Namespace;
  /** Agents' bearer token for POST /api/version/progress (a Worker secret). */
  PROGRESS_TOKEN?: string;
  /**
   * The Learning Partner tickets' public key (raw Ed25519, base64url: the
   * STT_TICKET_KEY pair's, ~/.config/lianki-stt/ticket.pub). Unset = every
   * socket from another site is refused.
   */
  PARTNER_TICKET_PUB?: string;
};
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

/** Fingerprints are kept for this many builds; a page older than that just gets the button. */
export const KEEP_FINGERPRINTS = 30;
const fpKey = (build: string) => `fp:${build}`;

/** The build a page said it runs (?b= on connect), kept on its socket across hibernation. */
const pageBuild = (ws: Socket): string | undefined => {
  try {
    const a = ws.deserializeAttachment?.() as { b?: unknown } | null | undefined;
    return typeof a?.b === "string" ? a.b : undefined;
  } catch {
    return undefined;
  }
};

/** Legacy publish body: a bare build id, with optional fingerprints in a header. */
function readPublish(req: Request, body: string): { build: string; fp: RouteFingerprints | null } {
  const build = body.slice(0, 64);
  // In a header, so the body stays the bare id an older lianki-push reads
  // (the main Worker deploys first: docs/shipping.md, "Deploy order").
  const header = req.headers.get(FINGERPRINTS_HEADER);
  let fp: RouteFingerprints | null = null;
  try {
    if (header) fp = parseFingerprints(JSON.parse(decodeURIComponent(header)));
  } catch {}
  return { build, fp: fp && fp.build === build ? fp : null };
}

export class VersionHub {
  constructor(
    private ctx: State,
    private env: Env,
  ) {}

  /** What to tell a page of build `from` about the serving `build` (lib/smart-refresh.ts). */
  private async news(build: string, from: string | undefined, memo: Map<string, string>) {
    const key = from ?? "";
    let msg = memo.get(key);
    if (msg === undefined) {
      const store = this.ctx.storage;
      const to = await store.get<RouteFingerprints>(fpKey(build));
      const was = from ? await store.get<RouteFingerprints>(fpKey(from)) : undefined;
      msg = JSON.stringify(versionNews(build, was, to));
      memo.set(key, msg);
    }
    return msg;
  }

  /** Keep `fp` for its build, forgetting the oldest beyond KEEP_FINGERPRINTS. */
  private async keep(fp: RouteFingerprints) {
    const store = this.ctx.storage;
    if (await store.get(fpKey(fp.build))) return;
    await store.put(fpKey(fp.build), fp);
    const order = [...((await store.get<string[]>("fp-order")) ?? []), fp.build];
    const drop = order.splice(0, Math.max(0, order.length - KEEP_FINGERPRINTS));
    for (const b of drop) await store.delete?.(fpKey(b));
    await store.put("fp-order", order);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/publish")) {
      const body = (await req.text()).trim();
      let explicit;
      if (req.headers.get("content-type")?.split(";")[0].trim() === "application/json") {
        try {
          explicit = explicitVersionNews(JSON.parse(body));
        } catch {
          return new Response("invalid version news", { status: 400 });
        }
      }
      const { build, fp } = readPublish(req, explicit?.build ?? body);
      if (!build) return new Response("empty build id", { status: 400 });
      if (fp) await this.keep(fp);
      // Every isolate of a version announces it: only the first is news.
      if ((await this.ctx.storage.get<string>("build")) === build)
        return Response.json({ build, pushed: 0 });
      await this.ctx.storage.put("build", build);
      const sockets = this.ctx.getWebSockets();
      const memo = new Map<string, string>();
      for (const ws of sockets)
        try {
          ws.send(
            explicit ? JSON.stringify(explicit) : await this.news(build, pageBuild(ws), memo),
          );
        } catch {}
      return Response.json({ build, pushed: sockets.length });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const from = url.searchParams.get("b")?.slice(0, 64) || undefined;
    if (from) pair[1].serializeAttachment?.({ b: from });
    const build = await this.ctx.storage.get<string>("build");
    if (build) pair[1].send(await this.news(build, from, new Map()));
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  // Pages only listen; whatever they send is ignored. Closing needs nothing.
  webSocketMessage() {}
  webSocketClose(ws: Socket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
}

const isInternal = (url: URL) => url.hostname === "lianki-push";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const wantsSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (url.pathname === "/api/version/ws") {
      if (!wantsSocket) return new Response("WebSocket only", { status: 426 });
      return env.HUB.get(env.HUB.idFromName("version")).fetch(req);
    }
    // Lianki's speech servers (stt-registry.ts): 404 while the flag stt.worker is
    // off (or cannot be read), and for anything but a socket. No identity passes:
    // a worker proves its key, a page shows its v2 ticket; neither has a cookie here.
    if (url.pathname === STT_WORKER_PATH || url.pathname === STT_SIGNAL_PATH) {
      const none = () => new Response(null, { status: 404 });
      if (!wantsSocket || !env.STT) return none();
      let on: unknown = false;
      try {
        on = await env.SESSIONS?.flag?.("stt.worker");
      } catch {}
      if (on !== true) return none();
      const headers = new Headers(req.headers);
      for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
      headers.delete(DEV_BRIDGE_HEADER);
      headers.delete(EMBED_HEADER);
      headers.delete(BOX_HEADER);
      headers.delete("cookie");
      headers.delete("authorization");
      // Where Cloudflare met this caller, for picking a worker near the page (never the client's say).
      headers.delete(COLO_HEADER);
      const colo = (req as { cf?: { colo?: unknown } }).cf?.colo;
      if (typeof colo === "string" && /^[A-Z]{3}$/.test(colo)) headers.set(COLO_HEADER, colo);
      return env.STT.get(env.STT.idFromName("stt")).fetch(new Request(req, { headers }));
    }
    if (url.pathname === "/api/version/read-stream") {
      if (!wantsSocket) return new Response("WebSocket only", { status: 426 });
      // The cookie decides whose hub this is; the query cannot name another's.
      const who = await debugIdentity(req, env.MAIN);
      if (!who || !env.READ_STREAM) return new Response("forbidden", { status: 403 });
      return env.READ_STREAM.get(env.READ_STREAM.idFromName(who.userId)).fetch(req);
    }
    if (url.pathname === "/internal/read-stream" && req.method === "POST" && isInternal(url)) {
      if (!env.READ_STREAM) return new Response("not bound", { status: 503 });
      const text = await req.text();
      let user: unknown;
      try {
        user = (JSON.parse(text) as { user?: unknown }).user;
      } catch {}
      if (typeof user !== "string" || !user) return new Response("bad body", { status: 400 });
      return env.READ_STREAM.get(env.READ_STREAM.idFromName(user)).fetch(
        new Request(req.url, { method: "POST", body: text }),
      );
    }
    if (url.pathname === "/api/version/debug") {
      if (!wantsSocket) return new Response("WebSocket only", { status: 426 });
      // A socket offering the partner subprotocol (the userscript's shadow
      // widget on another site, or the lianki.com frame inside it): its ticket
      // alone, never a cookie; chat-only in the owner's thread (debug.ts).
      // Any other socket: the cookie alone, and only from https://lianki.com.
      // The owner's box (docs/box-oauth.md) offers the same subprotocol with a box
      // chat ticket, good only from the box origin it names.
      if (offersPartner(req) || req.headers.get("origin") !== DEBUG_ORIGIN) {
        const t: { jti: string; exp: number; cid?: string } | null =
          (await partnerTicket(req, env.PARTNER_TICKET_PUB)) ??
          (await boxChatTicket(req, env.PARTNER_TICKET_PUB));
        if (!t) return new Response("forbidden", { status: 403 });
        const headers = new Headers(req.headers);
        for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
        headers.delete(DEV_BRIDGE_HEADER);
        headers.delete(BOX_HEADER);
        headers.delete("cookie");
        headers.set(IDENTITY_HEADERS.user, "owner");
        headers.set(IDENTITY_HEADERS.email, "");
        headers.set(IDENTITY_HEADERS.owner, "1");
        headers.set(EMBED_HEADER, `${t.jti}.${t.exp}`);
        if (t.cid) headers.set(BOX_HEADER, t.cid);
        return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(new Request(req, { headers }));
      }
      const who = await debugIdentity(req, env.MAIN);
      if (!who) return new Response("forbidden", { status: 403 });
      const headers = new Headers(req.headers);
      // Only what the main Worker said: a page cannot claim any of these itself.
      for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
      headers.delete(DEV_BRIDGE_HEADER);
      // A lianki.com page is never an embedded one, nor a box, whatever it sends.
      headers.delete(EMBED_HEADER);
      headers.delete(BOX_HEADER);
      headers.set(IDENTITY_HEADERS.user, who.userId);
      headers.set(IDENTITY_HEADERS.email, who.email);
      headers.set(IDENTITY_HEADERS.owner, who.owner ? "1" : "0");
      // A header holds bytes, not any name: percent-encoded.
      if (who.name) headers.set(IDENTITY_HEADERS.name, encodeURIComponent(who.name));
      if (who.image) headers.set(IDENTITY_HEADERS.image, who.image);
      if (who.session) headers.set(IDENTITY_HEADERS.session, who.session);
      if (who.sessionUntil) headers.set(IDENTITY_HEADERS.sessionUntil, String(who.sessionUntil));
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(new Request(req, { headers }));
    }
    if (
      url.pathname === "/api/version/progress" ||
      url.pathname.startsWith("/api/version/progress/")
    ) {
      if (!env.PROGRESS) return new Response("live progress is not deployed", { status: 503 });
      const hub = env.PROGRESS.get(env.PROGRESS.idFromName("progress"));
      if (!wantsSocket) {
        // Never a box header on a writer's request: only the socket route sets them.
        const refused = progressGate(req, env.PROGRESS_TOKEN);
        if (refused) return refused;
        const headers = new Headers(req.headers);
        headers.delete(PROGRESS_OWNER_HEADER);
        headers.delete(PROGRESS_BOX_HEADER);
        headers.delete(PROGRESS_TICKET_HEADER);
        return hub.fetch(new Request(req, { headers }));
      }
      // The owner's box (docs/box-oauth.md, "Chat on the owner's box"): no cookie,
      // a box chat ticket alone, from the box origin it names. Never a partner
      // ticket (the userscript's widget on any site), never the owner header.
      if (offersPartner(req)) {
        const t = await boxChatTicket(req, env.PARTNER_TICKET_PUB);
        if (!t?.cid) return new Response("forbidden", { status: 403 });
        const headers = new Headers(req.headers);
        headers.delete(DEV_BRIDGE_HEADER);
        headers.delete(PROGRESS_OWNER_HEADER);
        headers.delete("cookie");
        headers.set(PROGRESS_BOX_HEADER, t.cid);
        headers.set(PROGRESS_TICKET_HEADER, `${t.jti}.${t.exp}`);
        return hub.fetch(new Request(req, { headers }));
      }
      const who = await debugIdentity(req, env.MAIN);
      if (!who?.owner) return new Response("forbidden", { status: 403 });
      const headers = new Headers(req.headers);
      headers.delete(DEV_BRIDGE_HEADER);
      // A cookie page is never a box, whatever it sends.
      headers.delete(PROGRESS_BOX_HEADER);
      headers.delete(PROGRESS_TICKET_HEADER);
      headers.set(PROGRESS_OWNER_HEADER, "1");
      return hub.fetch(new Request(req, { headers }));
    }
    // The sender. Anyone may knock; it can do nothing until the owner allows
    // it on a page (debug.ts). A browser always sends Origin on a WebSocket,
    // so refusing one keeps web pages from raising prompts at all.
    if (url.pathname === "/api/version/debug/control") {
      if (!wantsSocket) return new Response("WebSocket only", { status: 426 });
      if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      const headers = new Headers(req.headers);
      for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
      // liagent's CLI resumes a grant (chat or eval) with x-liagent-token: the same token.
      const ours = headers.get("x-debug-token");
      const theirs = headers.get("x-liagent-token");
      if (ours && theirs && ours !== theirs)
        return new Response("x-debug-token and x-liagent-token differ", { status: 400 });
      if (theirs && !ours) headers.set("x-debug-token", theirs);
      headers.delete("x-liagent-token");
      // An eval token (lib/eval-token.ts): `Authorization: Bearer lk_…`. The hub
      // asks the main Worker about it; only this route's header can carry it.
      headers.delete(EVAL_TOKEN_HEADER);
      const bearer = /^Bearer (lk_[0-9a-f]{64})$/.exec(headers.get("authorization") ?? "");
      headers.delete("authorization");
      if (bearer) headers.set(EVAL_TOKEN_HEADER, bearer[1]);
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(new Request(req, { headers }));
    }
    // `lianki chat`: an API token's say/ask/read (POST) or listen (WebSocket),
    // each in its account's own thread (token-chat.ts). The hub asks the main
    // Worker about the token; nothing here is trusted. Not for browser pages:
    // a request with an Origin is refused, and no identity header passes.
    // An agent's avatar by its SHA-256 (token-chat.ts): the sanitized SVG, read
    // only, nothing of the caller passed on.
    if (
      url.pathname.startsWith(AVATAR_PATH) &&
      /^[0-9a-f]{64}$/.test(url.pathname.slice(AVATAR_PATH.length))
    ) {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(
        new Request(new URL(url.pathname, url.origin), { method: "GET" }),
      );
    }
    if (url.pathname === CHAT_PATH) {
      if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      const headers = new Headers(req.headers);
      for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
      headers.delete(DEV_BRIDGE_HEADER);
      headers.delete(EMBED_HEADER);
      headers.delete("cookie");
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(new Request(req, { headers }));
    }
    // Friends, a signed-out session (it stops eval-grant renewal bound to it),
    // and revoked API tokens (their listening sockets close).
    // A box lost box:chat: its chat sockets (the chat hub) and its state-tree
    // readers (the progress hub) close. An eval-only notice is the chat hub's alone.
    if (url.pathname === BOX_CLOSED_PATH && isInternal(url)) {
      const body = await req.text();
      const again = () => new Request(req.url, { method: req.method, headers: req.headers, body });
      const res = await env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(again());
      let evalOnly = false;
      try {
        evalOnly = (JSON.parse(body) as { scope?: unknown }).scope === "eval";
      } catch {}
      // Best effort, as the notice itself: the hub's own re-check is the guarantee.
      if (req.method === "POST" && !evalOnly && env.PROGRESS)
        try {
          await env.PROGRESS.get(env.PROGRESS.idFromName("progress")).fetch(again());
        } catch {}
      return res;
    }
    if (
      (url.pathname.startsWith("/internal/friends") ||
        url.pathname === "/internal/signed-out" ||
        url.pathname === REVOKED_PATH ||
        url.pathname === CHAT_BACKFILL_PATH) &&
      isInternal(url)
    )
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(req);
    if (url.pathname === "/internal/publish" && req.method === "POST" && isInternal(url))
      return env.HUB.get(env.HUB.idFromName("version")).fetch(req);
    // Pages from before the switch listen on the old Server-Sent Events
    // stream. Answer once with a build they are not, so they offer a refresh,
    // and tell EventSource not to come back for a day.
    if (url.pathname === "/api/version/stream")
      return new Response(`retry: 86400000\nevent: version\ndata: lianki-push\n\n`, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    return new Response("not found", { status: 404 });
  },
};
