/**
 * The state tree's live progress (and so the ETA bar) on the owner's box
 * (docs/box-oauth.md, "The state tree on the owner's box"). What matters: a
 * box reader gets in on a box chat ticket alone, from its own origin, once;
 * the main Worker is asked at connect, before sends once its last answer is
 * old, and before each ping it sends; "gone" closes it (4401); it never
 * resolves; a cookie page can never claim to be a box; the outline route opens
 * to a box:chat token only for GET.
 */
import { describe, expect, test } from "bun:test";
import {
  BOX_CHAT_TICKET_PATH,
  BOX_CHAT_TREE_PATH,
  SCOPE_CHAT,
  tokenMayCall,
} from "@/lib/box-oauth/rules";
import {
  BOX_CHAT_TICKET_AUD,
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  b64url,
  signSttTicket,
} from "@/lib/stt-ticket";
import { BOX_ENDED, liveTreeSource, type Sock } from "@/lib/progress-tree";
import { ownerFlagOn } from "@/lib/box-oauth/session";
import push, { type Env } from "@/workers/push/src/index";
import {
  BOX_RECHECK_MS,
  PROGRESS_BOX_CLOSED,
  PROGRESS_BOX_HEADER,
  PROGRESS_OWNER_HEADER,
  PROGRESS_TICKET_HEADER,
  ProgressHub,
} from "@/workers/push/src/progress";
import type { Socket, Storage } from "@/workers/push/src/debug";

const ORIGIN = "https://my-0123456789abcdef.lianki.com";
const OTHER = "https://my-fedcba9876543210.lianki.com";
const RW = ["box:read", "box:write"];
const ROOT = "root-secret";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

function fakeStorage(): Storage {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    async getAlarm() {
      return alarm;
    },
    async setAlarm(at: number) {
      alarm = at;
    },
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({ prefix }: { prefix: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  } as Storage;
}

function hubSetup(answer: { said: unknown } = { said: "live" }, rpc = true) {
  let t = 1_700_000_000_000;
  const sockets: FakeSocket[] = [];
  const asked: string[] = [];
  const debugSeen: Request[] = [];
  const hub = new ProgressHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    },
    {
      PROGRESS_TOKEN: ROOT,
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            debugSeen.push(r);
            return new Response("ok");
          },
        }),
      },
      ...(rpc
        ? {
            SESSIONS: {
              boxChat: async (cid: string) => {
                asked.push(cid);
                if (answer.said instanceof Error) throw answer.said;
                return answer.said;
              },
            },
          }
        : {}),
    },
    () => t,
  );
  const exp = () => Math.floor(t / 1000) + 60;
  const box = async (jti = "jti-0001", cid = "c1") =>
    hub.fetch(
      new Request("https://lianki-push/api/version/progress", {
        headers: {
          upgrade: "websocket",
          [PROGRESS_BOX_HEADER]: cid,
          [PROGRESS_TICKET_HEADER]: `${jti}.${exp()}`,
        },
      }),
    );
  const owner = async () => {
    const res = await hub.fetch(
      new Request("https://lianki-push/api/version/progress", {
        headers: { upgrade: "websocket", [PROGRESS_OWNER_HEADER]: "1" },
      }),
    );
    expect(res.status).toBe(101);
    return sockets.at(-1)!;
  };
  const write = (body: Record<string, unknown>) =>
    hub.fetch(
      new Request("https://lianki-push/api/version/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${ROOT}` },
        body: JSON.stringify({ agent: "a", status: "doing", task: "t", ...body }),
      }),
    );
  return {
    hub,
    sockets,
    asked,
    debugSeen,
    box,
    owner,
    write,
    tick: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("the progress hub: a box reader", () => {
  test("gets in on its ticket once, while the main Worker says live; sees the snapshot", async () => {
    const h = hubSetup();
    const res = await h.box();
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe(PARTNER_SUBPROTOCOL);
    expect(h.asked).toEqual(["c1"]);
    expect(h.sockets[0].sent[0]).toMatchObject({ type: "snapshot" });
    // The same ticket again: burned.
    expect((await h.box()).status).toBe(403);
    expect(h.sockets.length).toBe(1);
  });

  test("refused when the box is gone, the answer unsure, or the main Worker has no check", async () => {
    for (const said of ["gone", "busy", new Error("d1")]) {
      const h = hubSetup({ said });
      expect((await h.box()).status).toBe(403);
      expect(h.sockets.length).toBe(0);
    }
    const none = hubSetup({ said: "live" }, false);
    expect((await none.box()).status).toBe(403);
  });

  test("a bad client id or a missing / malformed / expired ticket is refused before any check", async () => {
    const h = hubSetup();
    const go = (headers: Record<string, string>) =>
      h.hub.fetch(
        new Request("https://lianki-push/api/version/progress", {
          headers: { upgrade: "websocket", ...headers },
        }),
      );
    const exp = Math.floor(h.now() / 1000) + 60;
    expect((await go({ [PROGRESS_BOX_HEADER]: "c1" })).status).toBe(403);
    expect(
      (await go({ [PROGRESS_BOX_HEADER]: "c 1", [PROGRESS_TICKET_HEADER]: `jti-0002.${exp}` }))
        .status,
    ).toBe(403);
    expect(
      (await go({ [PROGRESS_BOX_HEADER]: "c1", [PROGRESS_TICKET_HEADER]: "x.1" })).status,
    ).toBe(403);
    expect(
      (
        await go({
          [PROGRESS_BOX_HEADER]: "c1",
          [PROGRESS_TICKET_HEADER]: `jti-0003.${exp - 3600}`,
        })
      ).status,
    ).toBe(403);
    expect(h.asked).toEqual([]);
  });

  test("sends are re-checked once the last answer is old: gone closes it, the owner's pages go on", async () => {
    const answer = { said: "live" as unknown };
    const h = hubSetup(answer);
    await h.box();
    const ownerWs = await h.owner();
    const boxWs = h.sockets[0];
    await h.write({ id: "/x" });
    expect(h.asked.length).toBe(1); // fresh: no second ask
    expect(boxWs.sent.length).toBe(2);
    h.tick(BOX_RECHECK_MS + 1);
    answer.said = "busy";
    await h.write({ id: "/x", pct: 10 });
    expect(boxWs.sent.length).toBe(2); // unsure: this one skipped
    expect(boxWs.closed).toBeUndefined();
    answer.said = "gone";
    await h.write({ id: "/x", pct: 20 });
    expect(boxWs.closed).toBe(PROGRESS_BOX_CLOSED);
    expect(boxWs.sent.length).toBe(2);
    expect(ownerWs.sent.length).toBe(4); // snapshot + three events
  });

  test("a box pings ETAs (asked each time), and never resolves", async () => {
    const answer = { said: "live" as unknown };
    const h = hubSetup(answer);
    await h.write({ id: "/x", eta: "1m" });
    await h.write({ id: "/todo", status: "waiting-owner", needs: "ok?" });
    await h.box();
    const boxWs = h.sockets[0];
    h.tick(2 * 60_000);
    await h.hub.webSocketMessage(boxWs, JSON.stringify({ type: "resolve", id: "/todo" }));
    expect(h.asked.length).toBe(1);
    await h.hub.webSocketMessage(boxWs, JSON.stringify({ type: "eta", id: "/x" }));
    expect(h.asked.length).toBe(2);
    expect(h.debugSeen.length).toBe(1);
    // The to-do is still open.
    const state = await (
      await h.hub.fetch(
        new Request("https://lianki-push/api/version/progress", {
          headers: { authorization: `Bearer ${ROOT}` },
        }),
      )
    ).json();
    const todo = (state as { entries: { id: string; status: string }[] }).entries.find(
      (e) => e.id === "/todo",
    );
    expect(todo?.status).toBe("waiting-owner");
    // Gone: the ping is not taken and the socket closes.
    await h.write({ id: "/y", eta: "1m" });
    h.tick(2 * 60_000);
    answer.said = "gone";
    await h.hub.webSocketMessage(boxWs, JSON.stringify({ type: "eta", id: "/y" }));
    expect(h.debugSeen.length).toBe(1);
    expect(boxWs.closed).toBe(PROGRESS_BOX_CLOSED);
  });

  test("/internal/box-closed closes that box's readers only", async () => {
    const h = hubSetup();
    await h.box("jti-0001", "c1");
    await h.box("jti-0002", "c2");
    const ownerWs = await h.owner();
    const res = await h.hub.fetch(
      new Request("https://lianki-push/internal/box-closed", {
        method: "POST",
        body: JSON.stringify({ client: "c1" }),
      }),
    );
    expect(await res.json()).toEqual({ ok: true, closed: 1 });
    expect(h.sockets[0].closed).toBe(PROGRESS_BOX_CLOSED);
    expect(h.sockets[1].closed).toBeUndefined();
    expect(ownerWs.closed).toBeUndefined();
  });
});

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: b64url(raw) };
}

describe("lianki-push: the progress socket from a box", () => {
  const U = "https://lianki.com/api/version/progress";
  const setup = async () => {
    const k = await keys();
    const seen: Request[] = [];
    const debugSeen: Request[] = [];
    const env: Env = {
      HUB: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("v") }) },
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            debugSeen.push(r);
            return Response.json({ ok: true, closed: 0 });
          },
        }),
      },
      PROGRESS: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r);
            return new Response("p");
          },
        }),
      },
      MAIN: { fetch: async () => Response.json({ userId: "u1", email: "", owner: true }) },
      PARTNER_TICKET_PUB: k.pub,
    };
    return { k, seen, debugSeen, env };
  };
  const ws = (headers: Record<string, string>) =>
    new Request(U, { headers: { upgrade: "websocket", ...headers } });
  const offer = (t: string) => ({ "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${t}` });

  test("a box ticket from its own origin: the hub hears which box and the ticket; no owner header, no cookie", async () => {
    const { k, seen, env } = await setup();
    const { ticket } = await signSttTicket(k.priv, {
      aud: BOX_CHAT_TICKET_AUD,
      org: ORIGIN,
      cid: "c1",
    });
    const res = await push.fetch(
      ws({
        origin: ORIGIN,
        cookie: "s=1",
        [PROGRESS_OWNER_HEADER]: "1",
        [PROGRESS_BOX_HEADER]: "c9",
        ...offer(ticket),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const h = seen[0].headers;
    expect(h.get(PROGRESS_BOX_HEADER)).toBe("c1");
    expect(h.get(PROGRESS_TICKET_HEADER)).toMatch(/^[A-Za-z0-9_-]+\.\d+$/);
    expect(h.get(PROGRESS_OWNER_HEADER)).toBeNull();
    expect(h.get("cookie")).toBeNull();
  });

  test("refused: a partner ticket, another box's origin, lianki.com, a bad ticket", async () => {
    const { k, seen, env } = await setup();
    const p = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD });
    expect((await push.fetch(ws({ origin: ORIGIN, ...offer(p.ticket) }), env)).status).toBe(403);
    const b = await signSttTicket(k.priv, { aud: BOX_CHAT_TICKET_AUD, org: ORIGIN, cid: "c1" });
    for (const origin of [OTHER, "https://lianki.com", "https://github.com"])
      expect((await push.fetch(ws({ origin, ...offer(b.ticket) }), env)).status).toBe(403);
    expect((await push.fetch(ws({ origin: ORIGIN, ...offer("nope") }), env)).status).toBe(403);
    expect(seen.length).toBe(0);
  });

  test("a cookie page is never a box, whatever headers it sends", async () => {
    const { seen, env } = await setup();
    await push.fetch(
      ws({
        origin: "https://lianki.com",
        cookie: "s=1",
        [PROGRESS_BOX_HEADER]: "c1",
        [PROGRESS_TICKET_HEADER]: "j.1",
      }),
      env,
    );
    expect(seen[0].headers.get(PROGRESS_OWNER_HEADER)).toBe("1");
    expect(seen[0].headers.get(PROGRESS_BOX_HEADER)).toBeNull();
    expect(seen[0].headers.get(PROGRESS_TICKET_HEADER)).toBeNull();
    // Nor a writer.
    await push.fetch(
      new Request(U, {
        method: "POST",
        headers: { authorization: "Bearer t", [PROGRESS_BOX_HEADER]: "c1" },
      }),
      { ...env, PROGRESS_TOKEN: ROOT },
    );
    expect(seen[1].headers.get(PROGRESS_BOX_HEADER)).toBeNull();
  });

  test("/internal/box-closed reaches both hubs; an eval-only notice only the chat hub", async () => {
    const { seen, debugSeen, env } = await setup();
    const post = (body: unknown) =>
      push.fetch(
        new Request("https://lianki-push/internal/box-closed", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        env,
      );
    expect((await post({ client: "c1" })).status).toBe(200);
    expect(debugSeen.length).toBe(1);
    expect(seen.length).toBe(1);
    expect(await seen[0].json()).toEqual({ client: "c1" });
    await post({ client: "c1", scope: "eval" });
    expect(debugSeen.length).toBe(2);
    expect(seen.length).toBe(1);
    // Never from outside.
    const out = await push.fetch(
      new Request("https://lianki.com/internal/box-closed", { method: "POST", body: "{}" }),
      env,
    );
    expect(out.status).toBe(404);
    expect(seen.length).toBe(1);
  });
});

describe("the outline route for a box", () => {
  test("box:chat opens GET /api/dev/state-tree, nothing else on it", () => {
    expect(tokenMayCall("GET", BOX_CHAT_TREE_PATH, RW)).toEqual({
      ok: false,
      status: 404,
      reason: "path",
    });
    expect(tokenMayCall("GET", BOX_CHAT_TREE_PATH, [...RW, SCOPE_CHAT])).toEqual({
      ok: true,
      chat: true,
    });
    expect(tokenMayCall("POST", BOX_CHAT_TREE_PATH, [...RW, SCOPE_CHAT]).ok).toBe(false);
    expect(tokenMayCall("GET", `${BOX_CHAT_TREE_PATH}/x`, [...RW, SCOPE_CHAT]).ok).toBe(false);
    expect(tokenMayCall("GET", "/api/dev/state-treeX", [...RW, SCOPE_CHAT]).ok).toBe(false);
    // The ticket route stays POST only.
    expect(tokenMayCall("GET", BOX_CHAT_TICKET_PATH, [...RW, SCOPE_CHAT]).ok).toBe(false);
  });
});

describe("the live tree source with a ticket per connect", () => {
  const fakes = () => {
    const opened: { url: string; protocols?: string[]; sock: Sock }[] = [];
    const timers: (() => void)[] = [];
    return {
      opened,
      timers,
      deps: {
        base: () => "# Tree\n",
        url: "wss://lianki.com/api/version/progress",
        socket: (url: string, protocols?: string[]) => {
          const sock: Sock = {
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
            close() {},
          };
          opened.push({ url, protocols, sock });
          return sock;
        },
        setTimeout: (fn: () => void) => {
          timers.push(fn);
          return timers.length;
        },
        clearTimeout: () => {},
        onWake: () => () => {},
      },
    };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("offers a fresh ticket each connect; none to be had is a failed connect, tried later", async () => {
    const f = fakes();
    const tickets = [null, "t-1", "t-2"];
    const src = liveTreeSource({
      ...f.deps,
      protocols: async () => {
        const t = tickets.shift();
        return t ? [PARTNER_SUBPROTOCOL, t] : null;
      },
    });
    const stop = src.subscribe(() => {});
    await flush();
    expect(f.opened.length).toBe(0);
    expect(f.timers.length).toBe(1);
    f.timers.shift()!();
    await flush();
    expect(f.opened[0].protocols).toEqual([PARTNER_SUBPROTOCOL, "t-1"]);
    f.opened[0].sock.onclose?.({ code: 1006 });
    f.timers.shift()!();
    await flush();
    expect(f.opened[1].protocols).toEqual([PARTNER_SUBPROTOCOL, "t-2"]);
    stop();
  });

  test("a box that lost box:chat (4401) is not asked again until a wake", async () => {
    const f = fakes();
    const src = liveTreeSource({ ...f.deps, protocols: async () => [PARTNER_SUBPROTOCOL, "t"] });
    const stop = src.subscribe(() => {});
    await flush();
    f.opened[0].sock.onclose?.({ code: BOX_ENDED });
    expect(f.timers.length).toBe(0);
    stop();
  });

  test("without protocols: as before, no subprotocol offered", async () => {
    const f = fakes();
    const stop = liveTreeSource(f.deps).subscribe(() => {});
    expect(f.opened[0].protocols).toBeUndefined();
    stop();
  });
});

describe("the bar's flag on a box", () => {
  const me = { name: "o", email: "o@x", image: null } as never;
  test("off a box: the server's read; on a box: production's, for a site owner only", () => {
    expect(ownerFlagOn(false, undefined, "chat.eta-bar", true)).toBe(true);
    expect(ownerFlagOn(false, undefined, "chat.eta-bar", false)).toBe(false);
    // The box server's own read never turns it on.
    expect(ownerFlagOn(true, undefined, "chat.eta-bar", true)).toBe(false);
    expect(ownerFlagOn(true, null, "chat.eta-bar", true)).toBe(false);
    const on = { user: me, flags: { "chat.eta-bar": true }, owner: true };
    expect(ownerFlagOn(true, on, "chat.eta-bar", false)).toBe(true);
    expect(ownerFlagOn(true, { ...on, owner: false }, "chat.eta-bar", true)).toBe(false);
    expect(ownerFlagOn(true, { ...on, flags: {} }, "chat.eta-bar", true)).toBe(false);
  });
});
