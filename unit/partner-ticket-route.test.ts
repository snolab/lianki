/**
 * `POST /api/debug/partner-ticket` (lib/partner-ticket-auth.ts): a partner
 * ticket opens the owner's chat thread from another site, so a `study` token
 * (cards and settings) never gets one; a token needs chat:read + chat:write,
 * belongs to the owner's account, and the ticket it gets is chat-only in the
 * hub: no eval, no pairing. Also: no other /api/debug or /api/dev route takes
 * an API token at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { createToken, type ScopeId } from "@/lib/api-tokens";
import { type PartnerTicketDeps, partnerTicket } from "@/lib/partner-ticket-auth";
import {
  PARTNER_SUBPROTOCOL,
  PARTNER_TICKET_AUD,
  PARTNER_TICKET_HEADER,
  b64url,
  fromB64url,
} from "@/lib/stt-ticket";
import push, { type Env } from "@/workers/push/src/index";
import { EMBED_HEADER } from "@/workers/push/src/auth";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";

const SCHEMA = testSchema();
const T0 = Date.parse("2026-11-07T12:00:00Z");
const DAY = 86_400_000;
const OWNER = "owner@example.com";
const OTHER = "friend@example.com";

let d1: TestD1Database;
const db = () => d1 as unknown as D1Like;

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  for (const [id, email] of [
    ["uo", OWNER],
    ["uf", OTHER],
  ])
    d1.raw()
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
      )
      .run(id, email);
});

const mint = async (userId: string, email: string, scopes: ScopeId[], days = 30) =>
  (
    await createToken(
      db(),
      { userId, email },
      { name: "lane", scopes, expiresAt: new Date(T0 + days * DAY) },
      T0,
    )
  ).token;

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub: b64url(raw) };
}

const setup = async (o: { session?: string | null; backend?: "d1" | "mongodb" } = {}) => {
  const k = await keys();
  const asked: (string | null)[] = [];
  const deps: PartnerTicketDeps = {
    backend: () => o.backend ?? "d1",
    d1: db,
    sessionEmail: async () => o.session ?? null,
    isDev: async (e) => {
      asked.push(e);
      return e === OWNER;
    },
    key: async () => k.priv,
    now: () => T0 + 1000,
  };
  return { k, deps, asked };
};

const req = (auth?: string, header = true) =>
  new Request("https://lianki.com/api/debug/partner-ticket", {
    method: "POST",
    headers: {
      ...(header ? { [PARTNER_TICKET_HEADER]: "1" } : {}),
      ...(auth ? { Authorization: auth } : {}),
    },
  });

const payloadOf = (ticket: string) =>
  JSON.parse(new TextDecoder().decode(fromB64url(ticket.split(".")[0]))) as Record<string, unknown>;

describe("partner-ticket: who gets one", () => {
  it("a study-only token is refused, even the owner's own", async () => {
    const { deps } = await setup();
    const t = await mint("uo", OWNER, ["study"]);
    const r = await partnerTicket(req(`Bearer ${t}`), deps);
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain("ticket");
  });

  it("a token with only one of chat:read / chat:write, or only chat:ask, is refused", async () => {
    const { deps } = await setup();
    for (const s of [
      ["chat:read"],
      ["chat:write"],
      ["chat:ask"],
      ["study", "chat:ask"],
    ] as ScopeId[][])
      expect((await partnerTicket(req(`Bearer ${await mint("uo", OWNER, s)}`), deps)).status).toBe(
        404,
      );
  });

  it("the owner's chat token gets a chat-only partner ticket (audience and expiry, nothing else)", async () => {
    const { deps } = await setup();
    const t = await mint("uo", OWNER, ["chat:read", "chat:write"]);
    const r = await partnerTicket(req(`Bearer ${t}`), deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { ticket } = (await r.json()) as { ticket: string };
    const p = payloadOf(ticket);
    expect(Object.keys(p).sort()).toEqual(["aud", "exp", "iat", "jti"]);
    expect(p.aud).toBe(PARTNER_TICKET_AUD);
  });

  it("another account's chat token gets nothing: a partner ticket is the owner's thread", async () => {
    const { deps, asked } = await setup();
    const t = await mint("uf", OTHER, ["study", "chat:read", "chat:write", "chat:ask"]);
    expect((await partnerTicket(req(`Bearer ${t}`), deps)).status).toBe(404);
    expect(asked).toEqual([OTHER]);
  });

  it("expired, unknown, malformed, box tokens, and the Mongo copy: refused", async () => {
    const { deps } = await setup();
    const expired = await mint("uo", OWNER, ["chat:read", "chat:write"], -1);
    for (const h of [
      `Bearer ${expired}`,
      `Bearer lk_${"a".repeat(64)}`,
      `Bearer lkb_${"a".repeat(32)}`,
      "Basic x",
    ])
      expect((await partnerTicket(req(h), deps)).status).toBe(404);
    const mongo = await setup({ backend: "mongodb" });
    const good = await mint("uo", OWNER, ["chat:read", "chat:write"]);
    expect((await partnerTicket(req(`Bearer ${good}`), mongo.deps)).status).toBe(404);
  });

  it("the owner's session still works, with or without a token that does not qualify", async () => {
    const { deps } = await setup({ session: OWNER });
    expect((await partnerTicket(req(), deps)).status).toBe(200);
    const study = await mint("uo", OWNER, ["study"]);
    expect((await partnerTicket(req(`Bearer ${study}`), deps)).status).toBe(200);
    // A friend's session: nothing.
    const f = await setup({ session: OTHER });
    expect((await partnerTicket(req(), f.deps)).status).toBe(404);
  });

  it("without the userscript header, or without the key: no ticket", async () => {
    const { deps } = await setup({ session: OWNER });
    expect((await partnerTicket(req(undefined, false), deps)).status).toBe(404);
    expect((await partnerTicket(req(), { ...deps, key: async () => null })).status).toBe(503);
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

describe("a token's partner ticket in the hub: the owner's thread, chat only", () => {
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

  it("route → lianki-push → hub: an embedded socket that never sees eval, a pairing, or can Allow one", async () => {
    const { k, deps } = await setup();
    const tok = await mint("uo", OWNER, ["chat:read", "chat:write"]);
    // lianki-push checks the ticket against the real clock.
    const live = { ...deps, now: () => Date.now() };
    const { ticket } = (await (await partnerTicket(req(`Bearer ${tok}`), live)).json()) as {
      ticket: string;
    };

    // lianki-push verifies it and forwards it as an embedded (ticket) socket, cookie dropped.
    const forwarded: Request[] = [];
    const env: Env = {
      HUB: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("hub") }) },
      DEBUG: {
        idFromName: () => 0,
        get: () => ({
          fetch: async (r: Request) => {
            forwarded.push(r);
            return new Response("hub");
          },
        }),
      },
      MAIN: {
        fetch: async () => {
          throw new Error("a ticket socket never asks who the cookie is");
        },
      },
      PARTNER_TICKET_PUB: k.pub,
    };
    const up = await push.fetch(
      new Request("https://lianki.com/api/version/debug?label=github.com%2Fx", {
        headers: {
          upgrade: "websocket",
          origin: "https://github.com",
          cookie: "better-auth.session_token=x",
          "sec-websocket-protocol": `${PARTNER_SUBPROTOCOL}, ${ticket}`,
        },
      }),
      env,
    );
    expect(await up.text()).toBe("hub");
    expect(forwarded).toHaveLength(1);
    const fwd = forwarded[0];
    expect(fwd.headers.get("cookie")).toBeNull();
    expect(fwd.headers.get(EMBED_HEADER)).toBeTruthy();

    // The hub: that socket next to a real owner page and an agent asking to pair.
    const sockets: FakeSocket[] = [];
    const now = Date.now();
    const hub = new DebugHub(
      {
        acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
        getWebSockets: () => sockets,
        storage: fakeStorage(),
      },
      undefined,
      () => now,
    );
    const msg = (ws: FakeSocket, m: unknown) => hub.webSocketMessage(ws, JSON.stringify(m));
    await hub.fetch(
      new Request("https://lianki.com/api/version/debug?label=%2Fwords", {
        headers: { "x-debug-user": "uo", "x-debug-owner": "1" },
      }),
    );
    const owner = sockets.at(-1)!;
    expect((await hub.fetch(fwd)).status).toBe(101);
    const embed = sockets.at(-1)!;
    expect(embed).not.toBe(owner);
    await hub.fetch(new Request("https://lianki.com/api/version/debug/control?label=agent"));
    const ctl = sockets.at(-1)!;
    const pair = (owner.last("state") as { pending: { pair: string } }).pending.pair;

    // It cannot approve the pairing, and never sees it.
    await msg(embed, { type: "allow", pair });
    expect(ctl.last("approved")).toBeUndefined();
    for (const s of embed.sent.filter((m) => m.type === "state")) {
      expect(s.pending).toBeNull();
      expect(s.sessions).toEqual([]);
    }
    // Its chat lands in the owner thread.
    await msg(embed, { type: "chat", id: "t1", text: "via token" });
    expect((owner.last("chat") as { message: { thread: string } }).message.thread).toBe("owner");
    // Eval, once the owner allows the agent, reaches the owner page only.
    await msg(owner, { type: "allow", pair });
    await msg(ctl, { type: "eval", code: "1" });
    expect(owner.last("eval")).toBeTruthy();
    expect(embed.sent.some((m) => m.type === "eval" || m.type === "pending")).toBe(false);
  });
});

describe("no other /api/debug or /api/dev route takes an API token", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  const TOKEN_AUTH =
    /authEmailOrToken|getEmailByToken|apiTokenUser|checkToken|chatTokenCheck|partner-ticket-auth|Bearer lk_/;

  it("only partner-ticket, and only through lib/partner-ticket-auth.ts", () => {
    const files = readdirSync("app/api")
      .filter((d) => d === "debug" || d.startsWith("dev"))
      .flatMap((d) => walk(join("app/api", d)));
    expect(files.length).toBeGreaterThan(10);
    const takers = files.filter((f) => TOKEN_AUTH.test(readFileSync(f, "utf8")));
    expect(takers).toEqual([join("app/api/debug/partner-ticket/route.ts")]);
    const src = readFileSync(takers[0], "utf8");
    expect(src).not.toMatch(/authEmailOrToken|getEmailByToken|apiTokenUser/);
  });
});
