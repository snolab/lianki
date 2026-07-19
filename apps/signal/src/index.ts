import { DurableObject } from "cloudflare:workers";

// WebRTC signaling relay for Lianki card sync (deploys at s.lianki.com).
//
// One SignalRoom Durable Object per "room" — a room key derived from the user's
// identity (a hash of their token/email), so all of a user's devices meet in the
// same room and NO one else can guess it. The DO only relays the WebRTC
// handshake (offer/answer/ICE) between peers over WebSocket (hibernation API);
// once a peer connection is up, cards flow P2P over a data channel and the DO is
// out of the loop.

export interface Env {
  SIGNAL: DurableObjectNamespace<SignalRoom>;
}

export class SignalRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const peerId = crypto.randomUUID();
    // Hibernatable socket, tagged with its peer id.
    this.ctx.acceptWebSocket(server, [peerId]);

    const others = this.peerIds().filter((id) => id !== peerId);
    server.send(JSON.stringify({ type: "welcome", peerId, peers: others }));
    this.broadcast(server, JSON.stringify({ type: "peer-join", peerId }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    const from = this.tag(ws);
    let msg: { to?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const out = JSON.stringify({ ...msg, from });
    if (msg.to) {
      // Directed relay (offer/answer/ICE aimed at one peer).
      for (const peer of this.ctx.getWebSockets()) {
        if (this.tag(peer) === msg.to) peer.send(out);
      }
    } else {
      this.broadcast(ws, out);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.broadcast(ws, JSON.stringify({ type: "peer-leave", peerId: this.tag(ws) }));
  }

  webSocketError(ws: WebSocket): void {
    this.broadcast(ws, JSON.stringify({ type: "peer-leave", peerId: this.tag(ws) }));
  }

  private tag(ws: WebSocket): string {
    return this.ctx.getTags(ws)[0] ?? "";
  }
  private peerIds(): string[] {
    return this.ctx.getWebSockets().map((ws) => this.tag(ws));
  }
  private broadcast(except: WebSocket, data: string): void {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) ws.send(data);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "lianki-signal" });
    if (url.pathname === "/signal") {
      const room = url.searchParams.get("room");
      if (!room) return new Response("room required", { status: 400 });
      // Same room key → same DO instance → peers meet.
      return env.SIGNAL.getByName(room).fetch(request);
    }
    return new Response("lianki signaling server", { status: 200 });
  },
};
