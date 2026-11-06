// lianki-push's per-user hub for readers following a live Google Doc
// (docs/connections.md, "Live stream"), and its two routes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import push, { type Env } from "@/workers/push/src/index";
import { ReadStreamHub } from "@/workers/push/src/read-stream";

class FakeSocket {
  sent: string[] = [];
  closed?: number;
  failSend = false;
  failClose = false;
  send(s: string) {
    if (this.failSend) throw new Error("gone");
    this.sent.push(s);
  }
  close(code?: number) {
    if (this.failClose) throw new Error("gone");
    this.closed = code;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const RealResponse = globalThis.Response;

beforeEach(() => {
  g.WebSocketPair = class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  };
  // Only the Workers runtime lets a Response say 101.
  g.Response = class extends RealResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init?.status === 101 ? { status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
    }
  };
});
afterEach(() => {
  delete g.WebSocketPair;
  g.Response = RealResponse;
});

function hub() {
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const state = {
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => sockets.push({ ws, tags }),
    getWebSockets: (tag?: string) =>
      sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
  };
  return { hub: new ReadStreamHub(state as never), sockets };
}
const publish = (body: unknown) =>
  new Request("https://lianki-push/internal/read-stream", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("ReadStreamHub", () => {
  it("tells only the sockets on that book, with nothing but its id and hash", async () => {
    const { hub: h, sockets } = hub();
    expect((await h.fetch(new Request("https://x/s?book=a"))).status).toBe(101);
    await h.fetch(new Request("https://x/s?book=b"));
    const res = await h.fetch(publish({ book: "a", hash: "h1" }));
    expect(await res.json()).toEqual({ pushed: 1 });
    expect(sockets[0].ws.sent).toEqual([JSON.stringify({ book: "a", hash: "h1" })]);
    expect(sockets[1].ws.sent).toEqual([]);
  });

  it("passes live edits through to that book's sockets", async () => {
    const { hub: h, sockets } = hub();
    await h.fetch(new Request("https://x/s?book=a"));
    const ops = [{ i: 1, s: "x" }];
    await h.fetch(publish({ book: "a", ops }));
    expect(sockets[0].ws.sent).toEqual([JSON.stringify({ book: "a", ops })]);
  });

  it("refuses a bad book or body, and survives a dead socket", async () => {
    const { hub: h, sockets } = hub();
    expect((await h.fetch(new Request("https://x/s?book=../x"))).status).toBe(400);
    expect((await h.fetch(publish({ book: "../x", hash: "h" }))).status).toBe(400);
    expect((await h.fetch(publish({ book: "a" }))).status).toBe(400);
    await h.fetch(new Request("https://x/s?book=a"));
    sockets[0].ws.failSend = true;
    expect((await h.fetch(publish({ book: "a", hash: "h" }))).status).toBe(200);
  });

  it("ignores what a reader sends, and closes with it", () => {
    const { hub: h } = hub();
    const ws = new FakeSocket();
    h.webSocketMessage();
    h.webSocketClose(ws as never, 1005);
    expect(ws.closed).toBe(1000);
    h.webSocketClose(ws as never, 4001);
    expect(ws.closed).toBe(4001);
    ws.failClose = true;
    h.webSocketClose(ws as never, 1000);
  });
});

describe("the routes", () => {
  const named: string[] = [];
  const env = (over: Partial<Env> = {}) =>
    ({
      READ_STREAM: {
        idFromName: (n: string) => (named.push(n), n),
        get: () => ({ fetch: async () => new RealResponse("hub") }),
      },
      MAIN: {
        fetch: async () =>
          RealResponse.json({ userId: "u1", email: "e", owner: false, name: "", image: "" }),
      },
      ...over,
    }) as unknown as Env;
  const socketReq = (headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/version/read-stream?book=a", {
      headers: { upgrade: "websocket", ...headers },
    });

  it("a socket goes to the hub the cookie names, never another's", async () => {
    named.length = 0;
    const res = await push.fetch(socketReq({ origin: "https://lianki.com", cookie: "s=1" }), env());
    expect(await res.text()).toBe("hub");
    expect(named).toEqual(["u1"]);
  });

  it("refuses a plain request, another site, and no cookie", async () => {
    const plain = new Request("https://lianki.com/api/version/read-stream?book=a");
    expect((await push.fetch(plain, env())).status).toBe(426);
    const other = socketReq({ origin: "https://evil.test", cookie: "s=1" });
    expect((await push.fetch(other, env())).status).toBe(403);
    expect((await push.fetch(socketReq({ origin: "https://lianki.com" }), env())).status).toBe(403);
  });

  it("publishing is for the binding's own hostname, with a user", async () => {
    named.length = 0;
    const ok = await push.fetch(publish({ user: "u2", book: "a", hash: "h" }), env());
    expect(await ok.text()).toBe("hub");
    expect(named).toEqual(["u2"]);
    const pub = new Request("https://lianki.com/internal/read-stream", {
      method: "POST",
      body: JSON.stringify({ user: "u2" }),
    });
    expect(await (await push.fetch(pub, env())).text()).not.toBe("hub");
    expect((await push.fetch(publish({ book: "a" }), env())).status).toBe(400);
    const bad = new Request("https://lianki-push/internal/read-stream", {
      method: "POST",
      body: "not json",
    });
    expect((await push.fetch(bad, env())).status).toBe(400);
    expect((await push.fetch(publish({ user: "u" }), env({ READ_STREAM: undefined }))).status).toBe(
      503,
    );
  });
});
