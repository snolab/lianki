/**
 * One hub per user: an open reader on a live Google Doc hears each live edit,
 * and when the book was saved, which it then fetches (docs/connections.md,
 * "Live stream"). Edits pass through to the sender's own readers; nothing is
 * stored.
 */
type Socket = WebSocket & { accept?: () => void };
type State = {
  acceptWebSocket(ws: Socket, tags?: string[]): void;
  getWebSockets(tag?: string): Socket[];
};
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

const BOOK = /^[A-Za-z0-9_-]{1,64}$/;

export class ReadStreamHub {
  constructor(private ctx: State) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method === "POST") {
      const { book, hash, ops } = (await req.json()) as {
        book?: unknown;
        hash?: unknown;
        ops?: unknown;
      };
      if (
        typeof book !== "string" ||
        !BOOK.test(book) ||
        (typeof hash !== "string" && !Array.isArray(ops))
      )
        return new Response("bad body", { status: 400 });
      const sockets = this.ctx.getWebSockets(book);
      for (const ws of sockets)
        try {
          ws.send(JSON.stringify(Array.isArray(ops) ? { book, ops } : { book, hash }));
        } catch {}
      return Response.json({ pushed: sockets.length });
    }
    const book = new URL(req.url).searchParams.get("book") ?? "";
    if (!BOOK.test(book)) return new Response("bad book", { status: 400 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [book]);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  // Readers only listen.
  webSocketMessage() {}
  webSocketClose(ws: Socket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
}
