/**
 * The Learning Partner on another site (docs/dev-debug-widget.md, "On every
 * site"): ticket sockets from any origin, cookie sockets from lianki.com only,
 * and a ticket socket is chat-only in the owner's thread.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import push, { type Env } from "@/workers/push/src/index";
import { EMBED_HEADER, partnerTicket } from "@/workers/push/src/auth";
import { PARTNER_SUBPROTOCOL, PARTNER_TICKET_AUD, b64url, signSttTicket } from "@/lib/stt-ticket";

const NOW = 1_800_000_000_000;

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: b64url(raw) };
}

const upgrade = (headers: Record<string, string>) =>
  new Request("https://lianki.com/api/version/debug?label=github.com%2Fx", {
    headers: { upgrade: "websocket", ...headers },
  });

describe("partnerTicket: the ticket half of the split", () => {
  it("accepts a partner ticket from another site, once", async () => {
    const k = await keys();
    const { ticket } = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD, now: NOW });
    const req = () =>
      upgrade({
        origin: "https://github.com",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
      });
    const seen = new Map();
    const t = await partnerTicket(req(), k.pub, seen, NOW + 1000);
    expect(t?.jti).toBeTruthy();
    expect(await partnerTicket(req(), k.pub, seen, NOW + 2000)).toBeNull();
  });

  it("refuses it from no origin, without the key, or as the wrong audience; takes it from the lianki.com frame", async () => {
    const k = await keys();
    const { ticket } = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD, now: NOW });
    const proto = { "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}` };
    // The frame (/embed/partner) is lianki.com, third-party on the host site: no cookie, a ticket.
    expect(
      await partnerTicket(
        upgrade({ origin: "https://lianki.com", ...proto }),
        k.pub,
        new Map(),
        NOW,
      ),
    ).not.toBeNull();
    expect(await partnerTicket(upgrade(proto), k.pub, new Map(), NOW)).toBeNull();
    expect(
      await partnerTicket(
        upgrade({ origin: "https://a.com", ...proto }),
        undefined,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    // An STT ticket (same key, other audience) never opens a hub socket.
    const stt = (await signSttTicket(k.priv, { now: NOW })).ticket;
    expect(
      await partnerTicket(
        upgrade({
          origin: "https://a.com",
          "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${stt}`,
        }),
        k.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    // Another key's ticket, an expired one, or the ticket without the subprotocol.
    const other = await keys();
    expect(
      await partnerTicket(
        upgrade({ origin: "https://a.com", ...proto }),
        other.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
    expect(
      await partnerTicket(
        upgrade({ origin: "https://a.com", ...proto }),
        k.pub,
        new Map(),
        NOW + 70_000,
      ),
    ).toBeNull();
    expect(
      await partnerTicket(
        upgrade({ origin: "https://a.com", "sec-websocket-protocol": ticket }),
        k.pub,
        new Map(),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("lianki-push: cookie sockets from lianki.com only, ticket sockets from anywhere", () => {
  const env = async (seen: Headers[], mainCalls: string[]) => {
    const k = await keys();
    const e: Env = {
      HUB: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("hub") }) },
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            seen.push(r.headers);
            return new Response("hub");
          },
        }),
      },
      MAIN: {
        fetch: async (url) => {
          mainCalls.push(String(url));
          return Response.json({ userId: "u1", email: "o@x", owner: true });
        },
      },
      PARTNER_TICKET_PUB: k.pub,
    };
    return { e, k };
  };

  it("another site with a valid ticket reaches the hub as an embedded owner page, cookie dropped", async () => {
    const seen: Headers[] = [];
    const calls: string[] = [];
    const { e, k } = await env(seen, calls);
    const { ticket } = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD });
    const res = await push.fetch(
      upgrade({
        origin: "https://github.com",
        cookie: "better-auth.session_token=stolen",
        "x-debug-owner": "0",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
      }),
      e,
    );
    expect(await res.text()).toBe("hub");
    expect(calls).toEqual([]); // the cookie is never even looked at
    expect(seen[0].get("cookie")).toBeNull();
    expect(seen[0].get("x-debug-owner")).toBe("1");
    expect(seen[0].get(EMBED_HEADER)).toMatch(/^[A-Za-z0-9_-]+\.\d+$/);
  });

  it("another site with a cookie but no ticket is refused, and the cookie is not checked", async () => {
    const seen: Headers[] = [];
    const calls: string[] = [];
    const { e } = await env(seen, calls);
    const res = await push.fetch(upgrade({ origin: "https://github.com", cookie: "s=1" }), e);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("lianki.com (the frame) with a ticket and no cookie is a ticket socket: chat-only, cookie never asked", async () => {
    const seen: Headers[] = [];
    const calls: string[] = [];
    const { e, k } = await env(seen, calls);
    const { ticket } = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD });
    const res = await push.fetch(
      upgrade({
        origin: "https://lianki.com",
        cookie: "better-auth.session_token=x",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
      }),
      e,
    );
    expect(await res.text()).toBe("hub");
    expect(calls).toEqual([]); // the cookie is not looked at on a ticket socket
    expect(seen[0].get("cookie")).toBeNull();
    expect(seen[0].get(EMBED_HEADER)).toBeTruthy();
  });

  it("offering the partner subprotocol with no valid ticket is refused, even from lianki.com with a cookie", async () => {
    const seen: Headers[] = [];
    const calls: string[] = [];
    const { e } = await env(seen, calls);
    const res = await push.fetch(
      upgrade({
        origin: "https://lianki.com",
        cookie: "s=1",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, forged.ticket`,
      }),
      e,
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a lianki.com cookie page can never claim to be embedded", async () => {
    const seen: Headers[] = [];
    const { e } = await env(seen, []);
    await push.fetch(
      upgrade({
        origin: "https://lianki.com",
        cookie: "s=1",
        [EMBED_HEADER]: "abcdefgh.9999999999",
      }),
      e,
    );
    expect(seen[0].get(EMBED_HEADER)).toBeNull();
    expect(seen[0].get("x-debug-user")).toBe("u1");
  });
});

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

function fakeStorage(store = new Map<string, unknown>()): Storage {
  return {
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({ prefix, limit }: { prefix: string; limit?: number }) => {
      let ks = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (limit !== undefined) ks = ks.slice(0, limit);
      return new Map(ks.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

describe("DebugHub: an embedded page is chat-only", () => {
  // The Workers runtime's socket pair (bun has none); ours, whatever other files set.
  const g = globalThis as { WebSocketPair?: unknown };
  let had: unknown;
  beforeEach(() => {
    had = g.WebSocketPair;
    g.WebSocketPair = class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    };
  });
  afterEach(() => {
    g.WebSocketPair = had;
  });
  const T = 1_800_000_000_000;
  const setup = () => {
    const sockets: FakeSocket[] = [];
    const hub = new DebugHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
        getWebSockets: () => sockets,
        storage: fakeStorage(),
      },
      undefined,
      () => T,
    );
    const exp = Math.floor(T / 1000) + 60;
    const embedReq = (jti = "jti-aaaaaaaa", e = exp, label = "github.com/snolab/lianki Chrome") =>
      new Request(`https://lianki.com/api/version/debug?label=${encodeURIComponent(label)}`, {
        headers: { "x-debug-user": "owner", "x-debug-owner": "1", [EMBED_HEADER]: `${jti}.${e}` },
      });
    const ownerPage = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fwords", {
          headers: { "x-debug-user": "u1", "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    };
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    return { hub, sockets, embedReq, ownerPage, msg, exp };
  };

  it("burns the ticket: 101 with the subprotocol once, 403 on a replay or when expired", async () => {
    const { hub, embedReq, exp } = setup();
    const ok = await hub.fetch(embedReq());
    expect(ok.status).toBe(101);
    expect(ok.headers.get("sec-websocket-protocol")).toBe(PARTNER_SUBPROTOCOL);
    expect((await hub.fetch(embedReq())).status).toBe(403);
    expect((await hub.fetch(embedReq("jti-bbbbbbbb", exp - 120))).status).toBe(403);
    expect((await hub.fetch(embedReq("bad"))).status).toBe(403);
  });

  it("gets the owner's history and chat, and its lines post to the owner thread", async () => {
    const { hub, sockets, embedReq, ownerPage, msg } = setup();
    const owner = await ownerPage();
    await hub.fetch(embedReq());
    const embed = sockets.at(-1)!;
    expect(embed.last("history")).toEqual({ type: "history", messages: [] });
    await msg(embed, { type: "chat", id: "e1", text: "from github" });
    const line = owner.last("chat") as { message: { text: string; thread: string } };
    expect(line.message.text).toBe("from github");
    expect(line.message.thread).toBe("owner");
    expect((embed.last("chat") as { message: { id: string } }).message.id).toBe("e1");
  });

  it("a cookie page framed by another site (frame=foreign) is chat-only: no pairing, no Allow, no eval", async () => {
    const { hub, sockets, msg } = setup();
    const framed = async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Fwords&frame=foreign", {
          headers: { "x-debug-user": "u1", "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    };
    const f = await framed();
    // Only a framed page open: a pairing is refused outright (nothing could show it but the frame).
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=agent"));
    const lone = sockets.at(-1)!;
    expect(lone.closed).toBe(4404);
    // With a real owner page too, the framed one sees no pairing and cannot Allow it.
    const owner = await (async () => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=%2Flist", {
          headers: { "x-debug-user": "u1", "x-debug-owner": "1" },
        }),
      );
      return sockets.at(-1)!;
    })();
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=agent2"));
    const ctl = sockets.at(-1)!;
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;
    for (const s of f.sent.filter((m) => m.type === "state"))
      expect(Object.keys(s).sort()).toEqual(["listeners", "pending", "sessions", "type"]);
    await msg(f, { type: "allow", pair });
    expect(ctl.last("approved")).toBeUndefined();
    await msg(owner, { type: "allow", pair });
    await msg(ctl, { type: "eval", code: "1" });
    expect(owner.last("eval")).toBeTruthy();
    expect(f.sent.some((m) => m.type === "eval" || m.type === "pending")).toBe(false);
  });

  it("a raw ticket client never sees pairings, sessions, pages, nodes or ids, in any state", async () => {
    const { hub, sockets, embedReq, ownerPage, msg } = setup();
    const owner = await ownerPage();
    await hub.fetch(embedReq());
    const embed = sockets.at(-1)!;
    // A listener at a node, a pending pairing, then an approved eval session: all broadcast.
    await hub.fetch(
      new Request("https://lianki.com/api/version/debug/control?label=secret-agent&node=/words"),
    );
    const ctl = sockets.at(-1)!;
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;
    await msg(owner, { type: "allow", pair });
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=second"));
    expect(ctl.last("approved")).toBeTruthy();
    // The owner's page does see them (the control for this test).
    expect(owner.sent.some((m) => m.type === "state" && (m.sessions as unknown[]).length > 0)).toBe(
      true,
    );
    const states = embed.sent.filter((m) => m.type === "state");
    expect(states.length).toBeGreaterThan(2);
    for (const s of states)
      expect(Object.keys(s).sort()).toEqual(["listeners", "pending", "sessions", "type"]);
    for (const s of states) {
      expect(s.pending).toBeNull();
      expect(s.sessions).toEqual([]);
    }
    const raw = JSON.stringify(embed.sent);
    for (const leak of ["secret-agent", "/words", pair, '"pages"', '"self"', '"pending":{'])
      expect(raw).not.toContain(leak);
    expect(embed.sent.some((m) => m.type === "pending" || m.type === "eval")).toBe(false);
  });

  it("is never listed, never sent eval, and its pairing answers, taps and errors are ignored", async () => {
    const { hub, sockets, embedReq, ownerPage, msg } = setup();
    const owner = await ownerPage();
    await hub.fetch(embedReq());
    const embed = sockets.at(-1)!;
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=agent"));
    const ctl = sockets.at(-1)!;
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;
    // The embedded page tries to approve the pairing: ignored.
    await msg(embed, { type: "allow", pair });
    expect(ctl.last("approved")).toBeUndefined();
    await msg(embed, { type: "page-error", kind: "error", message: "x", path: "/", at: 1 });
    await msg(embed, { type: "answer", askId: "a1", choices: { q: ["o"] } });
    // The owner approves on lianki.com: eval reaches lianki.com only.
    await msg(owner, { type: "allow", pair });
    expect(ctl.last("approved")).toBeTruthy();
    await msg(ctl, { type: "eval", code: "document.cookie" });
    expect(owner.last("eval")).toBeTruthy();
    expect(embed.sent.some((m) => m.type === "eval")).toBe(false);
    const pages = (owner.last("state") as { pages: { label: string }[] }).pages;
    expect(pages.map((p) => p.label)).toEqual(["/words"]);
  });
});
