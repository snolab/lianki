import { describe, expect, it } from "bun:test";
import { DebugHub, type Socket } from "@/workers/push/src/debug";
import push, { type Env, VersionHub } from "@/workers/push/src/index";
import { isOwnerSocket } from "@/workers/push/src/auth";
import { APPROVAL_MS, PENDING_MS } from "@/lib/dev-eval";

/** A socket as the hibernation API hands it to the hub, recording what it was sent. */
class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const hub = new DebugHub(
    { acceptWebSocket: (ws) => sockets.push(ws as FakeSocket), getWebSockets: () => sockets },
    undefined,
    () => t,
  );
  const page = (label = "/words pwa iPhone") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    hub.connectPage(
      ws,
      new URL(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`),
    );
    return ws;
  };
  const controller = (label = "main lane") => {
    const ws = new FakeSocket();
    sockets.push(ws);
    hub.connectController(
      ws,
      new URL(`https://lianki.com/api/version/debug/control?label=${encodeURIComponent(label)}`),
    );
    return ws;
  };
  const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
  const pairOf = (p: FakeSocket) =>
    (p.last("state") as { pending: { pair: string } | null }).pending?.pair ?? "";
  return { hub, page, controller, msg, pairOf, tick: (ms: number) => (t += ms) };
}

describe("DebugHub pairing", () => {
  it("a controller cannot run code before the owner allows it", () => {
    const { page, controller, msg } = setup();
    const p = page();
    const c = controller();
    expect(c.last("pending")?.code).toMatch(/^[0-9a-f]{4}$/);
    msg(c, { type: "eval", code: "document.title" });
    expect(c.last("error")?.error).toBe("not approved yet");
    expect(p.sent.some((m) => m.type === "eval")).toBe(false);
  });

  it("the page is prompted with the label and the same short code", () => {
    const { page, controller } = setup();
    const p = page();
    const c = controller("lianki main lane on mac");
    const state = p.last("state") as { pending: { code: string; label: string } };
    expect(state.pending.label).toBe("lianki main lane on mac");
    expect(state.pending.code).toBe(c.last("pending")?.code as string);
  });

  it("after Allow, code reaches the pages and results come back", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    msg(p, { type: "allow", pair });
    expect(c.last("approved")).toBeTruthy();
    msg(c, { type: "eval", code: "1+1" });
    const ev = p.last("eval") as { id: string; code: string; to: string };
    expect(ev.code).toBe("1+1");
    expect(c.last("sent")).toMatchObject({ id: ev.id, delivered: 1 });
    msg(p, { type: "result", id: ev.id, to: ev.to, ok: true, value: "2" });
    expect(c.last("result")).toMatchObject({
      id: ev.id,
      ok: true,
      value: "2",
      page: "/words pwa iPhone",
    });
  });

  it("only pages whose label contains the target get the code", () => {
    const { page, controller, msg, pairOf } = setup();
    const phone = page("/words pwa iPhone");
    const mac = page("/list Macintosh");
    const c = controller();
    msg(phone, { type: "allow", pair: pairOf(phone) });
    msg(c, { type: "eval", code: "1", target: "iphone" });
    expect(phone.last("eval")).toBeTruthy();
    expect(mac.last("eval")).toBeUndefined();
  });

  it("Deny closes the controller", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    msg(p, { type: "deny", pair: pairOf(p) });
    expect(c.last("denied")).toBeTruthy();
    expect(c.closed).toBe(4403);
    expect((p.last("state") as { pending: unknown }).pending).toBeNull();
  });

  it("End revokes an approved session", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    msg(p, { type: "allow", pair });
    msg(p, { type: "revoke", pair });
    expect(c.closed).toBe(4401);
    expect((p.last("state") as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("one pairing waits at a time; a stale one is replaced", () => {
    const { page, controller, tick } = setup();
    page();
    const first = controller();
    const second = controller();
    expect(second.closed).toBe(4429);
    tick(PENDING_MS + 1);
    const third = controller();
    expect(first.closed).toBe(4408);
    expect(third.last("pending")).toBeTruthy();
  });

  it("an Allow after the prompt expired does nothing", () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    const pair = pairOf(p);
    tick(PENDING_MS + 1);
    msg(p, { type: "allow", pair });
    expect(c.last("approved")).toBeUndefined();
  });

  it("approval runs out after an hour", () => {
    const { page, controller, msg, pairOf, tick } = setup();
    const p = page();
    const c = controller();
    msg(p, { type: "allow", pair: pairOf(p) });
    tick(APPROVAL_MS + 1);
    msg(c, { type: "eval", code: "1" });
    expect(c.closed).toBe(4408);
    expect(p.last("eval")).toBeUndefined();
  });

  it("with no owner page open, a controller is turned away", () => {
    const { controller } = setup();
    const c = controller();
    expect(c.closed).toBe(4404);
  });

  it("a controller cannot approve itself or another controller", () => {
    const { page, controller, msg, pairOf } = setup();
    const p = page();
    const c = controller();
    msg(c, { type: "allow", pair: pairOf(p) });
    expect(c.last("approved")).toBeUndefined();
  });
});

describe("lianki-push debug routes", () => {
  const upgrade = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://lianki.com${path}`, { headers: { upgrade: "websocket", ...headers } });
  const env = (whoami: number, calls: string[] = []): Env => {
    const stub = { fetch: async () => new Response("hub") };
    return {
      HUB: { idFromName: () => 0, get: () => stub },
      DEBUG: { idFromName: () => 0, get: () => stub },
      MAIN: {
        fetch: async (url, init) => {
          calls.push(`${url} ${new Headers(init?.headers).get("cookie")}`);
          return whoami === 200
            ? Response.json({ owner: true })
            : new Response("no", { status: whoami });
        },
      },
    };
  };

  it("a page socket without the owner's session is refused", async () => {
    const own = { origin: "https://lianki.com", cookie: "s=1" };
    expect((await push.fetch(upgrade("/api/version/debug", own), env(404))).status).toBe(403);
    expect(
      (await push.fetch(upgrade("/api/version/debug", { origin: "https://lianki.com" }), env(200)))
        .status,
    ).toBe(403);
    expect(
      (
        await push.fetch(
          upgrade("/api/version/debug", { ...own, origin: "https://evil.example" }),
          env(200),
        )
      ).status,
    ).toBe(403);
  });

  it("the owner's cookie is checked by the main Worker", async () => {
    const calls: string[] = [];
    const req = upgrade("/api/version/debug", { origin: "https://lianki.com", cookie: "s=1" });
    expect(await isOwnerSocket(req, env(200, calls).MAIN)).toBe(true);
    expect(calls).toEqual(["https://lianki.com/api/dev/whoami s=1"]);
  });

  it("a controller from a browser (with Origin) is refused", async () => {
    const res = await push.fetch(
      upgrade("/api/version/debug/control", { origin: "https://evil.example" }),
      env(200),
    );
    expect(res.status).toBe(403);
  });

  it("internal paths answer only on the binding's hostname", async () => {
    const res = await push.fetch(
      new Request("https://lianki.com/internal/publish", { method: "POST", body: "x" }),
      env(200),
    );
    expect(res.status).toBe(404);
  });
});

// The Workers runtime's socket pair, for the hubs' fetch(); bun has none.
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

describe("DebugHub.fetch", () => {
  it("upgrades pages and controllers, and drops a closed controller from the prompt", async () => {
    const sockets: FakeSocket[] = [];
    const hub = new DebugHub({
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
    });
    const res = await hub.fetch(new Request("https://lianki.com/api/version/debug?label=p"));
    expect(res.status).toBe(101);
    const [page] = sockets;
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=c"));
    const ctl = sockets[1];
    expect(ctl.last("pending")).toBeTruthy();
    hub.webSocketClose(ctl, 1005);
    expect(ctl.closed).toBe(1000);
    expect((page.last("state") as { pending: unknown }).pending).toBeNull();
  });
});

describe("VersionHub", () => {
  const make = () => {
    const sockets: FakeSocket[] = [];
    const store = new Map<string, unknown>();
    const hub = new VersionHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as unknown as FakeSocket),
        getWebSockets: () => sockets as unknown as WebSocket[],
        storage: {
          get: async <T>(k: string) => store.get(k) as T | undefined,
          put: async (k: string, v: unknown) => void store.set(k, v),
        },
      },
      {} as Env,
    );
    const publish = (b: string) =>
      hub.fetch(new Request("https://lianki-push/internal/publish", { method: "POST", body: b }));
    return { hub, sockets, publish };
  };

  it("pushes a new build once, and names it to a page on connect", async () => {
    const { hub, sockets, publish } = make();
    expect((await publish(" ")).status).toBe(400);
    expect(await (await publish("b1")).json()).toEqual({ build: "b1", pushed: 0 });
    expect((await hub.fetch(new Request("https://lianki.com/api/version/ws"))).status).toBe(101);
    expect(sockets[0].sent).toEqual([{ build: "b1" }]);
    expect(await (await publish("b1")).json()).toEqual({ build: "b1", pushed: 0 });
    expect(await (await publish("b2")).json()).toEqual({ build: "b2", pushed: 1 });
    hub.webSocketMessage();
    hub.webSocketClose(sockets[0] as unknown as WebSocket, 1001);
    expect(sockets[0].closed).toBe(1001);
  });
});

describe("lianki-push routing", () => {
  const stub = (name: string) => ({ fetch: async () => new Response(name) });
  const env = (owner: boolean): Env => ({
    HUB: { idFromName: () => 0, get: () => stub("version") },
    DEBUG: { idFromName: () => 0, get: () => stub("debug") },
    MAIN: {
      fetch: async () =>
        owner ? Response.json({ owner: true }) : new Response("", { status: 404 }),
    },
  });
  const ws = { upgrade: "websocket" };
  const go = async (url: string, init: RequestInit, owner = true) =>
    push
      .fetch(new Request(url, init), env(owner))
      .then(async (r) => `${r.status} ${await r.text()}`);

  it("routes each path to its hub, and nothing else", async () => {
    expect(await go("https://lianki.com/api/version/ws", {})).toStartWith("426");
    expect(await go("https://lianki.com/api/version/ws", { headers: ws })).toBe("200 version");
    expect(await go("https://lianki.com/api/version/debug", {})).toStartWith("426");
    expect(
      await go("https://lianki.com/api/version/debug", {
        headers: { ...ws, origin: "https://lianki.com", cookie: "s=1" },
      }),
    ).toBe("200 debug");
    expect(await go("https://lianki.com/api/version/debug/control", {})).toStartWith("426");
    expect(await go("https://lianki.com/api/version/debug/control", { headers: ws })).toBe(
      "200 debug",
    );
    expect(await go("https://lianki-push/internal/publish", { method: "POST", body: "b" })).toBe(
      "200 version",
    );
    expect(await go("https://lianki.com/api/version/stream", {})).toContain("lianki-push");
    expect(await go("https://lianki.com/elsewhere", {})).toStartWith("404");
  });

  it("an owner check that fails to answer refuses the socket", async () => {
    const req = new Request("https://lianki.com/api/version/debug", {
      headers: { origin: "https://lianki.com", cookie: "s=1" },
    });
    expect(await isOwnerSocket(req, { fetch: () => Promise.reject(new Error("down")) })).toBe(
      false,
    );
    expect(await isOwnerSocket(req, undefined)).toBe(false);
  });
});
