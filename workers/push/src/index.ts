/**
 * lianki-push — the new-version notice, event-driven end to end
 * (app/components/NewVersionNotice.tsx is the page's side), and the owner's
 * remote-eval hub (debug.ts; app/components/DebugEval.tsx is the page).
 *
 *   GET  /api/version/ws       WebSocket. On connect: {"build": "<id>"} —
 *                              the build serving now — and again whenever
 *                              a new one is published. Nothing else is sent.
 *   POST /internal/publish     The main Worker, over its service binding
 *                              (PUSH), on the first request a new isolate
 *                              serves: body = its build id. A new one is
 *                              stored and pushed to every page; the same one
 *                              again does nothing.
 *   GET  /api/version/stream   The old SSE notice, for pages from before:
 *                              one "new version" event, then silence.
 *   GET  /api/version/debug    WebSocket for the OWNER's debug-mode pages
 *                              (?label=<path + user agent>). Accepted only
 *                              from a lianki.com page whose cookie the main
 *                              Worker (service binding MAIN, /api/dev/whoami)
 *                              says is the owner's; 403 otherwise.
 *   GET  /api/version/debug/control
 *                              WebSocket for the sender (scripts/dev/eval.ts):
 *                              unauthenticated, and useless until the owner
 *                              allows it on one of those pages (debug.ts) —
 *                              or it presents a live chat grant in the
 *                              x-debug-token header. The same sockets carry
 *                              the owner ⇄ agent chat.
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
import { isOwnerSocket } from "./auth";

export { DebugHub } from "./debug";

type Socket = WebSocket & { accept?: () => void };
type State = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> };
};
type Stub = { fetch(req: Request): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
export type Env = { HUB: Namespace; DEBUG: Namespace; MAIN?: Fetcher };
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

const message = (build: string) => JSON.stringify({ build });

export class VersionHub {
  constructor(
    private ctx: State,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/publish")) {
      const build = (await req.text()).trim().slice(0, 64);
      if (!build) return new Response("empty build id", { status: 400 });
      // Every isolate of a version announces it: only the first is news.
      if ((await this.ctx.storage.get<string>("build")) === build)
        return Response.json({ build, pushed: 0 });
      await this.ctx.storage.put("build", build);
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets)
        try {
          ws.send(message(build));
        } catch {}
      return Response.json({ build, pushed: sockets.length });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const build = await this.ctx.storage.get<string>("build");
    if (build) pair[1].send(message(build));
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
    if (url.pathname === "/api/version/debug") {
      if (!wantsSocket) return new Response("WebSocket only", { status: 426 });
      if (!(await isOwnerSocket(req, env.MAIN))) return new Response("forbidden", { status: 403 });
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(req);
    }
    // The sender. Anyone may knock; it can do nothing until the owner allows
    // it on a page (debug.ts). A browser always sends Origin on a WebSocket,
    // so refusing one keeps web pages from raising prompts at all.
    if (url.pathname === "/api/version/debug/control") {
      if (!wantsSocket) return new Response("WebSocket only", { status: 426 });
      if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      return env.DEBUG.get(env.DEBUG.idFromName("debug")).fetch(req);
    }
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
