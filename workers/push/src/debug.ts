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
 */
import {
  APPROVAL_MS,
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
export type DebugState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
};
type PageAtt = { role: "page"; label: string };
type ControllerAtt = { role: "controller" } & PairInfo;
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
const info = ({ pair, code, label, at, until }: ControllerAtt): PairInfo =>
  until ? { pair, code, label, at, until } : { pair, code, label, at };

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

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    if (url.pathname.endsWith("/control")) this.connectController(ws, url);
    else this.connectPage(ws, url);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** An owner page (already authenticated by index.ts) joins: tell it the state. */
  connectPage(ws: Socket, url: URL) {
    ws.serializeAttachment({
      role: "page",
      label: cleanLabel(url.searchParams.get("label"), MAX_LABEL),
    } satisfies PageAtt);
    send(ws, this.state());
  }

  /** A controller knocks: one pending pairing at a time, and only with a page to ask. */
  connectController(ws: Socket, url: URL) {
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

  webSocketMessage(ws: Socket, raw: string | ArrayBuffer) {
    const a = att(ws);
    if (a?.role === "page") this.fromPage(ws, a, raw);
    else if (a?.role === "controller") this.fromController(ws, a, raw);
  }

  private fromPage(ws: Socket, page: PageAtt, raw: unknown) {
    const m = parsePageMessage(raw);
    if (!m) return;
    const c = this.controller(m.type === "result" ? m.to : m.pair);
    if (!c) return send(ws, this.state());
    const t = this.now();
    if (m.type === "allow") {
      if (c.a.until || t - c.a.at >= PENDING_MS) return send(ws, this.state());
      const until = t + APPROVAL_MS;
      c.ws.serializeAttachment({ ...c.a, until } satisfies ControllerAtt);
      send(c.ws, { type: "approved", until });
      console.log(JSON.stringify({ msg: "debug.allow", pair: c.a.pair, label: c.a.label, until }));
      return this.broadcast();
    }
    if (m.type === "deny" || m.type === "revoke") {
      send(c.ws, { type: m.type === "deny" ? "denied" : "revoked" });
      close(c.ws, m.type === "deny" ? 4403 : 4401, m.type);
      console.log(JSON.stringify({ msg: `debug.${m.type}`, pair: c.a.pair, label: c.a.label }));
      return this.broadcast(c.ws);
    }
    // A result goes back only to an approved controller that is still in time.
    if (m.type !== "result" || !c.a.until || c.a.until <= t) return;
    const { type: _t, to: _to, ...rest } = m;
    send(c.ws, { type: "result", ...rest, page: page.label });
  }

  private fromController(ws: Socket, c: ControllerAtt, raw: unknown) {
    const t = this.now();
    if (!c.until) return send(ws, { type: "error", error: "not approved yet" });
    if (c.until <= t) {
      send(ws, { type: "expired" });
      close(ws, 4408, "approval expired");
      return this.broadcast(ws);
    }
    const m = parseControllerMessage(raw);
    if (!m.ok) return send(ws, { type: "error", error: m.error });
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
