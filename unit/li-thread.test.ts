/**
 * Per-site Li threads for the userscript pill (docs/userscript-li-chat.md,
 * "Per-site threads"; lib/li-thread.ts; flag ext.pill-chat-per-origin).
 *
 * - the thread id never spells the origin, and differs per account and site;
 * - lianki.com binds the ticket to the origin the userscript named, only with
 *   the flag on (off: the one thread, as before);
 * - lianki-push takes a site ticket only from the lianki.com frame naming the
 *   same origin it saw at the handshake: a ticket for site A is refused on B;
 * - the hub keeps each site's lines in its own thread, Li reads only those,
 *   and another account can never open it;
 * - the account's lianki.com list (/api/chat/sites) shows its sites alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stubGlobals } from "./support/globals";
import { rpcStub } from "./support/rpc-stub";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import push, { type Env } from "@/workers/push/src/index";
import {
  EMBED_HEADER,
  SUB_ORIGIN_HEADER,
  SUB_THREAD_HEADER,
  liChatTicket,
  partnerTicket as hubPartnerTicket,
} from "@/workers/push/src/auth";
import { liTicket, type LiTicketDeps } from "@/lib/li-ticket-route";
import { partnerTicket, type PartnerTicketDeps } from "@/lib/partner-ticket-auth";
import { chatSites } from "@/lib/chat-sites-route";
import { type ChatLogDb, accountsOf } from "@/lib/chat-log";
import { createTestD1 } from "@/lib/d1/testDb";
import {
  HOST_ORIGIN_HEADER,
  PER_ORIGIN_FLAG,
  baseThread,
  hostOrigin,
  parseSubThread,
  subThread,
  subThreadHash,
  threadHashKey,
  threadHashKeyFromJwk,
} from "@/lib/li-thread";
import {
  LI_CHAT_TICKET_AUD,
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  PARTNER_TICKET_HEADER,
  b64url,
  fromB64url,
  signSttTicket,
} from "@/lib/stt-ticket";
import { FLAGS } from "@/lib/flags";
import { PARTNER_AI_FLAG } from "@/lib/partner-ai-config";
import type { PartnerRequest, PartnerResult } from "@/lib/partner-ai-config";

const NOW = 1_800_000_000_000;
const A = "https://site-a.example";
const B = "https://site-b.example";

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: b64url(raw) };
}

const payloadOf = (ticket: string) =>
  JSON.parse(new TextDecoder().decode(fromB64url(ticket.split(".")[0]!))) as Record<
    string,
    unknown
  >;

// ── the thread id ────────────────────────────────────────────────────────────

describe("the site thread id", () => {
  it("an origin is only an origin: no path, query, fragment, userinfo, or other scheme", () => {
    expect(hostOrigin("https://news.example")).toBe("https://news.example");
    expect(hostOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of [
      "https://news.example/",
      "https://news.example/story?id=1",
      "https://news.example#x",
      "https://user:pw@news.example",
      "https://NEWS.example",
      "https://news.example:443",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "null",
      "",
      `https://${"a".repeat(85)}.example`,
      5,
    ])
      expect(hostOrigin(bad)).toBeNull();
  });

  it("never spells the origin, and differs per account and per site; stable for the same pair", async () => {
    const key = await threadHashKey("secret-1");
    const a1 = await subThreadHash(key, "user_1", A);
    expect(a1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a1).not.toContain("site");
    expect(await subThreadHash(key, "user_1", A)).toBe(a1);
    expect(await subThreadHash(key, "user_1", B)).not.toBe(a1);
    expect(await subThreadHash(key, "user_2", A)).not.toBe(a1);
    expect(await subThreadHash(key, "owner", A)).not.toBe(a1);
    // Without the server key, the same guess gives another hash.
    expect(await subThreadHash(await threadHashKey("secret-2"), "user_1", A)).not.toBe(a1);
    const t = subThread("user_1", a1);
    expect(t).toBe(`user_1~${a1}`);
    expect(parseSubThread(t)).toEqual({ base: "user_1", hash: a1 });
    expect(baseThread(t)).toBe("user_1");
    expect(baseThread("user_1")).toBe("user_1");
    expect(parseSubThread("user_1")).toBeNull();
    expect(parseSubThread(`a:b~${a1}`)).toBeNull();
    expect(parseSubThread("user_1~short")).toBeNull();
  });

  it("the key comes from STT_TICKET_KEY's private part; none without it", async () => {
    expect(await threadHashKeyFromJwk(undefined)).toBeNull();
    expect(await threadHashKeyFromJwk("not json")).toBeNull();
    expect(await threadHashKeyFromJwk(JSON.stringify({ kty: "OKP" }))).toBeNull();
    expect(await threadHashKeyFromJwk(JSON.stringify({ d: "abc" }))).not.toBeNull();
  });

  it("the flag ships off: it changes what a ticket reaches, the owner turns it on", () => {
    expect(FLAGS[PER_ORIGIN_FLAG].default).toBe(false);
  });

  it("a ticket with the longest origin stays under the verifier's 512 characters", async () => {
    const k = await keys();
    const ho = `https://${"a".repeat(84)}.example`;
    expect(ho.length).toBe(100);
    expect(hostOrigin(ho)).toBe(ho);
    const th = await subThreadHash(await threadHashKey("s"), "u".repeat(64), ho);
    const { ticket } = await signSttTicket(k.priv, {
      aud: LI_CHAT_TICKET_AUD,
      sub: "u".repeat(64),
      ho,
      th,
    });
    expect(ticket.length).toBeLessThan(512);
  });
});

// ── lianki.com mints it bound ────────────────────────────────────────────────

describe("minting: the ticket is bound to the origin the userscript named", () => {
  const req = (h: Record<string, string>) =>
    new Request("https://lianki.com/api/chat/li-ticket", {
      method: "POST",
      headers: { [PARTNER_TICKET_HEADER]: "1", ...h },
    });
  const setup = async (perOrigin: boolean) => {
    const k = await keys();
    const tk = await threadHashKey("s");
    const deps: LiTicketDeps = {
      backend: () => "d1",
      d1: () => ({}) as never,
      sessionUser: async () => ({ id: "user_1", email: "u@x" }),
      isDev: async () => false,
      flags: async () => ({
        "ext.pill-chat": true,
        "ext.pill-chat-users": true,
        [PER_ORIGIN_FLAG]: perOrigin,
      }),
      key: async () => k.priv,
      allow: async () => true,
      threadKey: async () => tk,
      now: () => NOW,
    };
    return { deps, tk };
  };

  it("flag on: the ticket carries the origin and that site's hash under the account", async () => {
    const { deps, tk } = await setup(true);
    const r = await liTicket(req({ [HOST_ORIGIN_HEADER]: A }), deps);
    expect(r.status).toBe(200);
    const p = payloadOf(((await r.json()) as { ticket: string }).ticket);
    expect(p).toMatchObject({ sub: "user_1", ho: A, th: await subThreadHash(tk, "user_1", A) });
  });

  it("flag on: no origin, or anything more than an origin, gets no ticket", async () => {
    const { deps } = await setup(true);
    expect((await liTicket(req({}), deps)).status).toBe(404);
    expect((await liTicket(req({ [HOST_ORIGIN_HEADER]: `${A}/path?q=1` }), deps)).status).toBe(404);
    deps.threadKey = async () => null;
    expect((await liTicket(req({ [HOST_ORIGIN_HEADER]: A }), deps)).status).toBe(404);
  });

  it("flag off: as today, one thread: no origin in the ticket even when the userscript names one", async () => {
    const { deps } = await setup(false);
    const r = await liTicket(req({ [HOST_ORIGIN_HEADER]: A }), deps);
    const p = payloadOf(((await r.json()) as { ticket: string }).ticket);
    expect(p.ho).toBeUndefined();
    expect(p.th).toBeUndefined();
  });

  it("the owner's partner ticket: bound under his own thread when the pill names its site", async () => {
    const k = await keys();
    const tk = await threadHashKey("s");
    const deps = (on: boolean): PartnerTicketDeps => ({
      backend: () => "d1",
      d1: () => ({}) as never,
      sessionEmail: async () => "o@x",
      isDev: async () => true,
      key: async () => k.priv,
      flags: async () => ({ [PER_ORIGIN_FLAG]: on }),
      threadKey: async () => tk,
      now: () => NOW,
    });
    const preq = (h: Record<string, string> = {}) =>
      new Request("https://lianki.com/api/debug/partner-ticket", {
        method: "POST",
        headers: { [PARTNER_TICKET_HEADER]: "1", ...h },
      });
    const bound = payloadOf(
      (
        (await (await partnerTicket(preq({ [HOST_ORIGIN_HEADER]: A }), deps(true))).json()) as {
          ticket: string;
        }
      ).ticket,
    );
    expect(bound).toMatchObject({
      aud: PARTNER_TICKET_AUD,
      ho: A,
      th: await subThreadHash(tk, "owner", A),
    });
    // The debug widget names no site: his own thread, as before. Flag off: never bound.
    for (const [r, on] of [
      [preq(), true],
      [preq({ [HOST_ORIGIN_HEADER]: A }), false],
    ] as const) {
      const p = payloadOf(
        ((await (await partnerTicket(r, deps(on))).json()) as { ticket: string }).ticket,
      );
      expect(p.ho).toBeUndefined();
    }
    expect(
      (await partnerTicket(preq({ [HOST_ORIGIN_HEADER]: "https://a.example/x" }), deps(true)))
        .status,
    ).toBe(404);
  });
});

// ── lianki-push takes it only where it was minted for ────────────────────────

const upgrade = (h: Record<string, string>, q = "") =>
  new Request(`https://lianki.com/api/version/debug?label=x${q}`, {
    headers: { upgrade: "websocket", ...h },
  });

describe("lianki-push: a site ticket opens only its own site's thread", () => {
  const env = async (seen: Headers[]) => {
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
      MAIN: { fetch: async () => Response.json({ userId: "user_9", email: "u9@x", owner: false }) },
      PARTNER_TICKET_PUB: k.pub,
    };
    return { e, k };
  };
  const th = "AAAAAAAAAAAAAAAAAAAAAA";

  it("from the lianki.com frame naming the same origin: the site headers go to the hub", async () => {
    const seen: Headers[] = [];
    const { e, k } = await env(seen);
    const { ticket } = await signSttTicket(k.priv, {
      aud: LI_CHAT_TICKET_AUD,
      sub: "user_1",
      ho: A,
      th,
    });
    const res = await push.fetch(
      upgrade(
        {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
        },
        `&ho=${encodeURIComponent(A)}`,
      ),
      e,
    );
    expect(await res.text()).toBe("hub");
    expect(seen[0].get(SUB_THREAD_HEADER)).toBe(th);
    expect(seen[0].get(SUB_ORIGIN_HEADER)).toBe(A);
    expect(seen[0].get("x-debug-user")).toBe("user_1");
  });

  it("a ticket for site A, opened in a frame on site B (or naming none, or not from the frame), is refused", async () => {
    for (const [origin, q] of [
      ["https://lianki.com", `&ho=${encodeURIComponent(B)}`],
      ["https://lianki.com", ""],
      [A, `&ho=${encodeURIComponent(A)}`],
    ] as const) {
      const seen: Headers[] = [];
      const { e, k } = await env(seen);
      for (const aud of [LI_CHAT_TICKET_AUD, PARTNER_TICKET_AUD]) {
        const { ticket } = await signSttTicket(k.priv, {
          aud,
          ...(aud === LI_CHAT_TICKET_AUD ? { sub: "user_1" } : {}),
          ho: A,
          th,
        });
        const res = await push.fetch(
          upgrade({ origin, "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}` }, q),
          e,
        );
        expect(res.status).toBe(403);
      }
      expect(seen).toEqual([]);
    }
  });

  it("a refused site ticket is not spent: the same one still opens from the right frame", async () => {
    const k = await keys();
    const seen = new Map<string, number>();
    const { ticket } = await signSttTicket(k.priv, {
      aud: LI_CHAT_TICKET_AUD,
      sub: "user_1",
      ho: A,
      th,
      now: NOW,
    });
    const at = (ho: string) =>
      upgrade(
        {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
        },
        `&ho=${encodeURIComponent(ho)}`,
      );
    expect(await liChatTicket(at(B), k.pub, seen, NOW)).toBeNull();
    expect(await liChatTicket(at(A), k.pub, seen, NOW)).toMatchObject({ sub: "user_1", ho: A, th });
    expect(await liChatTicket(at(A), k.pub, seen, NOW)).toBeNull(); // once
    const owner = await signSttTicket(k.priv, { aud: PARTNER_TICKET_AUD, ho: A, th, now: NOW });
    const oat = (ho: string) =>
      upgrade(
        {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${owner.ticket}`,
        },
        `&ho=${encodeURIComponent(ho)}`,
      );
    expect(await hubPartnerTicket(oat(B), k.pub, seen, NOW)).toBeNull();
    expect(await hubPartnerTicket(oat(A), k.pub, seen, NOW)).toMatchObject({ ho: A, th });
  });

  it("a page cannot claim a site thread itself: the headers are dropped on every other route", async () => {
    const seen: Headers[] = [];
    const { e, k } = await env(seen);
    // A cookie page on lianki.com.
    await push.fetch(
      upgrade({
        origin: "https://lianki.com",
        cookie: "s=1",
        [SUB_THREAD_HEADER]: th,
        [SUB_ORIGIN_HEADER]: A,
      }),
      e,
    );
    // An unbound ticket (flag off): the one thread, as before.
    const { ticket } = await signSttTicket(k.priv, { aud: LI_CHAT_TICKET_AUD, sub: "user_1" });
    await push.fetch(
      upgrade({
        origin: "https://lianki.com",
        "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
        [SUB_THREAD_HEADER]: th,
        [SUB_ORIGIN_HEADER]: A,
      }),
      e,
    );
    expect(seen.length).toBe(2);
    for (const h of seen) {
      expect(h.get(SUB_THREAD_HEADER)).toBeNull();
      expect(h.get(SUB_ORIGIN_HEADER)).toBeNull();
    }
  });
});

// ── the hub ──────────────────────────────────────────────────────────────────

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
    getAlarm: async () => null,
    setAlarm: async () => {},
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let ks = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) ks.reverse();
      if (limit !== undefined) ks = ks.slice(0, limit);
      return new Map(ks.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

describe("DebugHub: each site's thread is its own", () => {
  let restore = () => {};
  beforeEach(() => {
    restore = stubGlobals({
      WebSocketPair: class {
        0 = new FakeSocket();
        1 = new FakeSocket();
      },
    });
  });
  afterEach(() => restore());
  const HA = "AAAAAAAAAAAAAAAAAAAAAA";
  const HB = "BBBBBBBBBBBBBBBBBBBBBB";

  const setup = (o: { perOrigin?: boolean; ai?: boolean } = {}) => {
    const sockets: FakeSocket[] = [];
    const calls: PartnerRequest[] = [];
    let t = NOW;
    const sessions = {
      live: async () => "gone",
      flag: async (k: string) =>
        k === PER_ORIGIN_FLAG
          ? (o.perOrigin ?? true)
          : k === PARTNER_AI_FLAG
            ? (o.ai ?? false)
            : false,
      partnerReply: async (req: PartnerRequest): Promise<PartnerResult> => {
        calls.push(structuredClone(req));
        return {
          ok: true,
          text: `Li on ${req.history.length}`,
          tokensIn: 10,
          tokensOut: 5,
          model: "m",
        } as PartnerResult;
      },
    };
    const hub = new DebugHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
        getWebSockets: () => sockets,
        storage: fakeStorage(),
      },
      { SESSIONS: rpcStub(sessions) },
      () => t,
    );
    const exp = Math.floor(NOW / 1000) + 60;
    let n = 0;
    /** As index.ts forwards a ticket socket: an account's (`user`) or the owner's (no user). */
    const ticketPage = async (user: string | null, site?: { hash: string; origin: string }) => {
      await hub.fetch(
        new Request("https://lianki.com/api/version/debug?label=site%2Fa", {
          headers: {
            "x-debug-user": user ?? "owner",
            "x-debug-email": "",
            "x-debug-owner": user ? "0" : "1",
            [EMBED_HEADER]: `jti-${String(++n).padStart(8, "0")}.${exp}`,
            ...(site ? { [SUB_THREAD_HEADER]: site.hash, [SUB_ORIGIN_HEADER]: site.origin } : {}),
          },
        }),
      );
      return sockets.at(-1)!;
    };
    const cookiePage = async (user: string, owner: boolean, q = "") => {
      await hub.fetch(
        new Request(`https://lianki.com/api/version/debug?label=%2Fchat%2Fsites${q}`, {
          headers: {
            "x-debug-user": user,
            "x-debug-email": `${user}@x`,
            "x-debug-owner": owner ? "1" : "0",
            // His signed-in page carries its session tag (index.ts), as in production.
            ...(owner
              ? {
                  "x-debug-session": "a".repeat(64),
                  "x-debug-session-until": String(NOW + 3_600_000),
                }
              : {}),
          },
        }),
      );
      return sockets.at(-1)!;
    };
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    return { hub, calls, ticketPage, cookiePage, msg, tick: (ms: number) => (t += ms) };
  };
  const texts = (ws: FakeSocket) =>
    ws.sent
      .filter((m) => m.type === "chat")
      .map((m) => (m as { message: { text: string } }).message.text);

  it("site A's lines stay in A's thread: not in B's, not in the account's own, not in another account's", async () => {
    const { ticketPage, cookiePage, msg } = setup();
    const own = await cookiePage("user_1", false);
    const a = await ticketPage("user_1", { hash: HA, origin: A });
    const b = await ticketPage("user_1", { hash: HB, origin: B });
    const other = await ticketPage("user_2", { hash: HA, origin: A });
    expect(a.last("history")).toMatchObject({ thread: `user_1~${HA}` });
    expect(other.last("history")).toMatchObject({ thread: `user_2~${HA}` });
    await msg(a, { type: "chat", id: "a1", text: "on site A" });
    await msg(b, { type: "chat", id: "b1", text: "on site B" });
    expect(texts(a)).toEqual(["on site A"]);
    expect(texts(b)).toEqual(["on site B"]);
    expect(texts(own)).toEqual([]);
    expect(texts(other)).toEqual([]);
  });

  it("with no site in the ticket (flag off at minting) it is the account's one thread, as before", async () => {
    const { ticketPage, cookiePage, msg } = setup({ perOrigin: false });
    const own = await cookiePage("user_1", false);
    const t = await ticketPage("user_1");
    expect(t.last("history")).toMatchObject({ thread: "user_1" });
    await msg(t, { type: "chat", id: "l1", text: "one thread" });
    expect(texts(own)).toEqual(["one thread"]);
  });

  it("his lianki.com page opens his own site's thread; another account's page is refused", async () => {
    const { ticketPage, cookiePage, msg } = setup();
    const a = await ticketPage("user_1", { hash: HA, origin: A });
    await msg(a, { type: "chat", id: "a1", text: "on site A" });
    const mine = await cookiePage("user_1", false, `&sub=${HA}`);
    expect(mine.closed).toBeUndefined();
    expect(mine.last("history")).toMatchObject({ thread: `user_1~${HA}` });
    await msg(mine, { type: "chat", id: "m1", text: "from lianki.com" });
    expect(texts(a)).toEqual(["on site A", "from lianki.com"]);
    // Another account asking for the same hash: no such thread under its own account.
    const thief = await cookiePage("user_2", false, `&sub=${HA}`);
    expect(thief.closed).toBe(4404);
    expect(texts(thief)).toEqual([]);
    // Nor the owner, nor a hash nobody holds, nor junk.
    expect((await cookiePage("owner_id", true, `&sub=${HA}`)).closed).toBe(4404);
    expect((await cookiePage("user_1", false, `&sub=${HB}`)).closed).toBe(4404);
    expect((await cookiePage("user_1", false, "&sub=..%2F")).closed).toBe(4404);
  });

  it("flag off: a lianki.com page cannot open a site thread", async () => {
    const { ticketPage, cookiePage } = setup({ perOrigin: false });
    await ticketPage("user_1", { hash: HA, origin: A });
    expect((await cookiePage("user_1", false, `&sub=${HA}`)).closed).toBe(4404);
  });

  it("one hash, one origin: a record for another origin is never merged", async () => {
    const { ticketPage } = setup();
    await ticketPage("user_1", { hash: HA, origin: A });
    expect((await ticketPage("user_1", { hash: HA, origin: B })).closed).toBe(4404);
  });

  it("Li's context holds only that site's thread: an account's and the owner's", async () => {
    const { ticketPage, cookiePage, msg, calls, tick } = setup({ ai: true });
    // The account: lines on its own thread and on site B first.
    const own = await cookiePage("user_1", false);
    await msg(own, { type: "chat", id: "o1", text: "own thread line" });
    tick(1000);
    const b = await ticketPage("user_1", { hash: HB, origin: B });
    await msg(b, { type: "chat", id: "b1", text: "site B line" });
    tick(1000);
    const a = await ticketPage("user_1", { hash: HA, origin: A });
    calls.length = 0;
    await msg(a, { type: "chat", id: "a1", text: "site A line" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.userId).toBe("user_1");
    expect(calls[0]!.owner).toBeUndefined();
    const said = calls[0]!.history.map((h) => h.text).join("\n");
    expect(said).toContain("site A line");
    expect(said).not.toContain("site B line");
    expect(said).not.toContain("own thread line");
    // Li's reply lands in A's thread only.
    expect(texts(a).at(-1)).toMatch(/^Li on /);
    // B has its own one reply (to its own line), never A's.
    expect(texts(b).filter((x) => x.startsWith("Li on")).length).toBe(1);

    // The owner: his site thread, with his account from his lianki.com page.
    await cookiePage("owner_id", true);
    const oa = await ticketPage(null, { hash: HA, origin: A });
    expect(oa.last("history")).toMatchObject({ thread: `owner~${HA}` });
    calls.length = 0;
    await msg(oa, { type: "chat", id: "w1", text: "owner on site A" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.userId).toBe("owner_id");
    expect(calls[0]!.owner).toBe(true);
    expect(calls[0]!.history.map((h) => h.text)).toEqual(["owner on site A"]);
  });

  it("the account's list: its sites by origin, with the last line; never another account's", async () => {
    const { hub, ticketPage, msg, tick } = setup();
    const a = await ticketPage("user_1", { hash: HA, origin: A });
    await msg(a, { type: "chat", id: "a1", text: "first" });
    tick(5000);
    await msg(a, { type: "chat", id: "a2", text: "latest on A" });
    tick(5000);
    await ticketPage("user_1", { hash: HB, origin: B });
    await ticketPage("user_2", { hash: HA, origin: "https://elsewhere.example" });
    const list = await hub.subThreads("user_1");
    expect(list.map((t) => t.origin)).toEqual([B, A]);
    expect(list[1]).toMatchObject({ id: HA, last: { text: "latest on A" } });
    expect(list[0]!.last).toBeUndefined();
    expect((await hub.subThreads("user_2")).map((t) => t.origin)).toEqual([
      "https://elsewhere.example",
    ]);
    expect(await hub.subThreads("owner")).toEqual([]);
    // The internal API answers the same, for a base the main Worker names from the session.
    const r = await hub.fetch(new Request("https://lianki-push/internal/sub-threads?base=user_1"));
    expect(((await r.json()) as { threads: unknown[] }).threads.length).toBe(2);
    expect(
      (await hub.fetch(new Request("https://lianki-push/internal/sub-threads?base=a%3Ab"))).status,
    ).toBe(400);
  });
});

// ── lianki.com's list ────────────────────────────────────────────────────────

describe("GET /api/chat/sites", () => {
  const get = () => new Request("https://lianki.com/api/chat/sites");
  const deps = (o: { on?: boolean; who?: { id: string; owner: boolean } | null }) => {
    const asked: string[] = [];
    return {
      asked,
      d: {
        who: async () => (o.who === undefined ? { id: "user_1", owner: false } : o.who),
        flags: async () => ({ [PER_ORIGIN_FLAG]: o.on ?? true }),
        list: async (base: string) => (asked.push(base), []),
      },
    };
  };

  it("the session's own account only: a user's id, the owner's thread for him", async () => {
    const u = deps({});
    expect((await chatSites(get(), u.d)).status).toBe(200);
    expect(u.asked).toEqual(["user_1"]);
    const o = deps({ who: { id: "owner_id", owner: true } });
    await chatSites(get(), o.d);
    expect(o.asked).toEqual(["owner"]);
  });

  it("404 with the flag off, signed out, or as POST; nothing asked", async () => {
    for (const [r, x] of [
      [get(), deps({ on: false })],
      [get(), deps({ who: null })],
      [new Request("https://lianki.com/api/chat/sites", { method: "POST" }), deps({})],
    ] as const) {
      expect((await chatSites(r, x.d)).status).toBe(404);
      expect(x.asked).toEqual([]);
    }
  });
});

// ── the account's history ────────────────────────────────────────────────────

describe("a site thread's lines are its account's history", () => {
  it("accountsOf: the base account, never the origin", async () => {
    const d = createTestD1(`CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE account_permission (email TEXT, permission TEXT, revoked_at INTEGER);`);
    d.raw().exec(`INSERT INTO user VALUES ('user_1', 'u@x')`);
    const db = d as unknown as ChatLogDb;
    expect(await accountsOf(db, "user_1~AAAAAAAAAAAAAAAAAAAAAA")).toEqual(["user_1"]);
    expect(await accountsOf(db, "nobody~AAAAAAAAAAAAAAAAAAAAAA")).toEqual([]);
  });
});
