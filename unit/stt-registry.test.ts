// lianki-push's SttRegistry (workers/push/src/stt-registry.ts): speech servers
// dial out and prove their key; a page with a v2 ticket gets a worker with
// room, its account's own worker first; offers, answers and ICE pass only
// between a page and its own worker; usage is booked to the ticket's account;
// both routes are 404 while the flag is off.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import push, { type Env } from "@/workers/push/src/index";
import {
  STT_SIGNAL_PATH,
  STT_WORKER_PATH,
  SttRegistry,
  WORKER_AUTH_PREFIX,
  workerSigned,
} from "@/workers/push/src/stt-registry";
import { b64url, importTicketKey, signSttTicket, signSttTicketV2 } from "@/lib/stt-ticket";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { bookSttUsage, sttWorkerLive } from "@/lib/stt-worker/rpc";
import { addSttWorker, sttWorkerByKey, type SttDb } from "@/lib/stt-worker/store";
import {
  main as addWorker,
  parseWorkerArgs,
  workerAddSql,
  writeOwner,
} from "@/scripts/local-stt/stt-worker-add";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeSocket {
  sent: string[] = [];
  closed?: number;
  att: unknown = null;
  send(s: string) {
    this.sent.push(s);
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
  last() {
    return JSON.parse(this.sent.at(-1) ?? "null");
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const RealResponse = globalThis.Response;
beforeEach(() => {
  g.WebSocketPair = class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  };
  g.Response = class extends RealResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init?.status === 101 ? { status: 200, headers: init.headers } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
    }
  };
});
afterEach(() => {
  delete g.WebSocketPair;
  g.Response = RealResponse;
});

async function edKeys() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  return {
    priv: p.privateKey,
    pub: b64url(raw),
    ticketKey: await importTicketKey(
      JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }),
    ),
  };
}
const sign = async (k: CryptoKey, nonce: string) =>
  b64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        k,
        new TextEncoder().encode(WORKER_AUTH_PREFIX + nonce),
      ),
    ),
  );

function setup(o: { workers?: Record<string, unknown>; cfg?: Record<string, number> } = {}) {
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const store = new Map<string, unknown>();
  const booked: [string, number][] = [];
  const state = {
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => sockets.push({ ws, tags }),
    getWebSockets: (tag?: string) =>
      sockets
        .filter((s) => s.ws.closed === undefined && (!tag || s.tags.includes(tag)))
        .map((s) => s.ws),
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...store].filter(([k]) => k.startsWith(prefix))),
    },
  };
  const sessions = {
    flag: async () => true,
    config: async (k: string) => o.cfg?.[k],
    sttWorker: async (key: string) => o.workers?.[key] ?? null,
    bookStt: async (u: string, ms: number) => void booked.push([u, ms]),
  };
  return { state, sockets, booked, sessions, store };
}

async function registered(reg: SttRegistry, k: Awaited<ReturnType<typeof edKeys>>) {
  const res = await reg.fetch(new Request(`https://lianki.com${STT_WORKER_PATH}`));
  expect(res.status).toBe(101);
  const w = (res as unknown as { webSocket: FakeSocket }).webSocket;
  // The server side is pair[1]; its sent challenge is what the worker reads.
  return w;
}

describe("SttRegistry", () => {
  it("a worker proves its key, then is registered; a wrong signature or unknown key is closed", async () => {
    const k = await edKeys();
    const s = setup({ workers: { [k.pub]: { id: "mac", ownerUserId: null, capacity: null } } });
    const reg = new SttRegistry(s.state as never, {
      SESSIONS: s.sessions,
      PARTNER_TICKET_PUB: k.pub,
    });
    await registered(reg, k);
    const server = s.sockets[0].ws;
    const { nonce } = JSON.parse(server.sent[0]);
    await reg.webSocketMessage(
      server as never,
      JSON.stringify({ t: "auth", key: k.pub, sig: await sign(k.priv, "other") }),
    );
    expect(server.closed).toBe(4401);

    await registered(reg, k);
    const s2 = s.sockets[1].ws;
    const n2 = JSON.parse(s2.sent[0]).nonce;
    expect(n2).not.toBe(nonce);
    await reg.webSocketMessage(
      s2 as never,
      JSON.stringify({ t: "auth", key: k.pub, sig: await sign(k.priv, n2) }),
    );
    expect(s2.last()).toEqual({ t: "registered", id: "mac" });

    const stranger = await edKeys();
    await registered(reg, stranger);
    const s3 = s.sockets[2].ws;
    const n3 = JSON.parse(s3.sent[0]).nonce;
    await reg.webSocketMessage(
      s3 as never,
      JSON.stringify({ t: "auth", key: stranger.pub, sig: await sign(stranger.priv, n3) }),
    );
    expect(s3.closed).toBe(4403);
  });

  it("a worker socket from a browser (an Origin) is refused", async () => {
    const s = setup();
    const reg = new SttRegistry(s.state as never, {});
    const r = await reg.fetch(
      new Request(`https://lianki.com${STT_WORKER_PATH}`, {
        headers: { origin: "https://lianki.com" },
      }),
    );
    expect(r.status).toBe(403);
  });

  it("a page with a v2 ticket gets a worker; signalling passes both ways; usage is booked to its account", async () => {
    const k = await edKeys();
    const s = setup({ workers: { [k.pub]: { id: "mac", ownerUserId: null, capacity: null } } });
    const reg = new SttRegistry(s.state as never, {
      SESSIONS: s.sessions,
      PARTNER_TICKET_PUB: k.pub,
    });
    await registered(reg, k);
    const worker = s.sockets[0].ws;
    await reg.webSocketMessage(
      worker as never,
      JSON.stringify({
        t: "auth",
        key: k.pub,
        sig: await sign(k.priv, JSON.parse(worker.sent[0]).nonce),
      }),
    );
    const { ticket } = await signSttTicketV2(k.ticketKey, {
      sub: "u1",
      lim: { utt: 40, sess: 900 },
    });
    const pageReq = () =>
      new Request(`https://lianki.com${STT_SIGNAL_PATH}`, {
        headers: {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `lianki-stt2, ${ticket}`,
        },
      });
    const r = await reg.fetch(pageReq());
    expect(r.status).toBe(101);
    expect(r.headers.get("sec-websocket-protocol")).toBe("lianki-stt2");
    const page = s.sockets[1].ws;
    const { sid } = page.last();
    await reg.webSocketMessage(page as never, JSON.stringify({ t: "offer", sdp: "v=0 offer" }));
    expect(worker.last()).toEqual({ t: "offer", sid, sdp: "v=0 offer", ticket });
    await reg.webSocketMessage(
      worker as never,
      JSON.stringify({ t: "answer", sid, sdp: "v=0 answer" }),
    );
    expect(page.last()).toEqual({ t: "answer", sdp: "v=0 answer" });
    await reg.webSocketMessage(worker as never, JSON.stringify({ t: "usage", sid, audioMs: 1500 }));
    expect(s.booked).toEqual([["u1", 1500]]);
    // The same ticket again: spent.
    expect((await reg.fetch(pageReq())).status).toBe(401);
  });

  it("refuses a v1 ticket, a wrong Origin, a second session for the account, and no worker with room", async () => {
    const k = await edKeys();
    const s = setup({
      workers: { [k.pub]: { id: "mac", ownerUserId: null, capacity: 2 } },
      cfg: { "stt.worker.macReserved": 1 },
    });
    const reg = new SttRegistry(s.state as never, {
      SESSIONS: s.sessions,
      PARTNER_TICKET_PUB: k.pub,
    });
    const req = (t: string, origin = "https://lianki.com") =>
      new Request(`https://lianki.com${STT_SIGNAL_PATH}`, {
        headers: { origin, "sec-websocket-protocol": `lianki-stt2, ${t}` },
      });
    const v2 = async (sub: string) =>
      (await signSttTicketV2(k.ticketKey, { sub, lim: { utt: 40, sess: 900 } })).ticket;
    // No worker yet.
    expect((await reg.fetch(req(await v2("u1")))).status).toBe(503);
    await registered(reg, k);
    const worker = s.sockets[0].ws;
    await reg.webSocketMessage(
      worker as never,
      JSON.stringify({
        t: "auth",
        key: k.pub,
        sig: await sign(k.priv, JSON.parse(worker.sent[0]).nonce),
      }),
    );
    expect((await reg.fetch(req((await signSttTicket(k.ticketKey)).ticket))).status).toBe(401);
    expect((await reg.fetch(req(await v2("u1"), "https://evil.example"))).status).toBe(403);
    expect((await reg.fetch(req(await v2("u1")))).status).toBe(101);
    expect((await reg.fetch(req(await v2("u1")))).status).toBe(429); // sessionsPerAccount 1
    // capacity 2 − 1 reserved for the owner: the next account finds no room.
    expect((await reg.fetch(req(await v2("u2")))).status).toBe(503);
  });

  it("the account's own worker first; a worker speaks only for its own sessions", async () => {
    const shared = await edKeys();
    const own = await edKeys();
    const s = setup({
      workers: {
        [shared.pub]: { id: "mac", ownerUserId: null, capacity: null },
        [own.pub]: { id: "ann-mac", ownerUserId: "u1", capacity: 1 },
      },
    });
    const reg = new SttRegistry(s.state as never, {
      SESSIONS: s.sessions,
      PARTNER_TICKET_PUB: shared.pub,
    });
    for (const k of [shared, own]) {
      await registered(reg, k);
      const w = s.sockets.at(-1)!.ws;
      await reg.webSocketMessage(
        w as never,
        JSON.stringify({
          t: "auth",
          key: k.pub,
          sig: await sign(k.priv, JSON.parse(w.sent[0]).nonce),
        }),
      );
    }
    const [sharedWs, ownWs] = [s.sockets[0].ws, s.sockets[1].ws];
    const { ticket } = await signSttTicketV2(shared.ticketKey, {
      sub: "u1",
      lim: { utt: 40, sess: 900 },
    });
    await reg.fetch(
      new Request(`https://lianki.com${STT_SIGNAL_PATH}`, {
        headers: {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `lianki-stt2, ${ticket}`,
        },
      }),
    );
    const page = s.sockets[2].ws;
    const { sid } = page.last();
    await reg.webSocketMessage(page as never, JSON.stringify({ t: "offer", sdp: "o" }));
    expect(ownWs.last().t).toBe("offer");
    expect(sharedWs.sent.some((m) => m.includes('"offer"'))).toBe(false);
    // The shared worker cannot answer, or book, for that session.
    const before = page.sent.length;
    await reg.webSocketMessage(sharedWs as never, JSON.stringify({ t: "answer", sid, sdp: "x" }));
    await reg.webSocketMessage(sharedWs as never, JSON.stringify({ t: "usage", sid, audioMs: 9 }));
    expect(page.sent.length).toBe(before);
    expect(s.booked).toEqual([]);
  });

  it("the worker's signature check matches what stt-peer signs", async () => {
    const k = await edKeys();
    expect(await workerSigned(k.pub, "n", await sign(k.priv, "n"))).toBe(true);
    expect(await workerSigned(k.pub, "n", await sign(k.priv, "m"))).toBe(false);
    expect(await workerSigned("short", "n", "x")).toBe(false);
  });
});

describe("the routes", () => {
  const env = (flag: boolean, hit: string[]): Env =>
    ({
      HUB: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("hub") }) },
      DEBUG: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("debug") }) },
      STT: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async (r: Request) => {
            hit.push(new URL(r.url).pathname);
            return new Response("stt");
          },
        }),
      },
      SESSIONS: { live: async () => "gone", flag: async () => flag, config: async () => undefined },
    }) as unknown as Env;
  const sock = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://lianki.com${path}`, { headers: { upgrade: "websocket", ...headers } });

  it("404 while the flag is off; the hub never sees it", async () => {
    const hit: string[] = [];
    for (const p of [STT_WORKER_PATH, STT_SIGNAL_PATH])
      expect((await push.fetch(sock(p), env(false, hit))).status).toBe(404);
    expect(hit).toEqual([]);
  });

  it("a flag that cannot be read is off", async () => {
    const hit: string[] = [];
    const e = env(true, hit) as unknown as { SESSIONS: { flag: () => Promise<boolean> } };
    e.SESSIONS.flag = async () => {
      throw new Error("main worker down");
    };
    expect((await push.fetch(sock(STT_SIGNAL_PATH), e as unknown as Env)).status).toBe(404);
    expect(hit).toEqual([]);
  });

  it("on: both reach the one registry; not a socket is 404", async () => {
    const hit: string[] = [];
    expect((await push.fetch(sock(STT_WORKER_PATH), env(true, hit))).status).toBe(200);
    expect((await push.fetch(sock(STT_SIGNAL_PATH, { cookie: "x" }), env(true, hit))).status).toBe(
      200,
    );
    expect(
      (await push.fetch(new Request(`https://lianki.com${STT_SIGNAL_PATH}`), env(true, hit)))
        .status,
    ).toBe(404);
    expect(hit).toEqual([STT_WORKER_PATH, STT_SIGNAL_PATH]);
  });
});

describe("what the registry asks the main Worker (lib/stt-worker/rpc.ts)", () => {
  const KEY = "A".repeat(43);
  async function db(flag: boolean | null) {
    const d = createTestD1(testSchema()) as unknown as SttDb & {
      exec(q: string): Promise<unknown>;
    };
    if (flag !== null)
      await d.exec(
        `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('stt.worker', ${flag ? 1 : 0}, 'x', 'x')`,
      );
    await addSttWorker(d, { id: "mac", pubkey: KEY, name: "Mac" }, "cli");
    return d;
  }
  const rows = async (d: SttDb) =>
    (
      await d
        .prepare("SELECT user_id, feature, units, usd_micro FROM cost_ledger")
        .bind()
        .all<{ user_id: string; feature: string; units: number; usd_micro: number }>()
    ).results;

  it("nothing while the flag is off (no row: off by default)", async () => {
    for (const f of [null, false]) {
      const d = await db(f);
      expect(await sttWorkerLive(d, KEY)).toBeNull();
      expect(await bookSttUsage(d, "u1", 1000)).toBe(false);
      expect(await rows(d)).toEqual([]);
    }
  });

  it("on: the worker by key; usage booked as speech.stt.local, clamped, at the config rate", async () => {
    const d = await db(true);
    expect(await sttWorkerLive(d, KEY)).toEqual({ id: "mac", ownerUserId: null, capacity: null });
    expect(await sttWorkerLive(d, "B".repeat(43))).toBeNull();
    expect(await sttWorkerLive(d, 5)).toBeNull();
    expect(await bookSttUsage(d, "u1", 60_000)).toBe(true);
    expect(await bookSttUsage(d, "u1", 10 * 60_000)).toBe(true); // clamped to 120 s
    expect(await bookSttUsage(d, "a@b.c", 1000)).toBe(false);
    expect(await bookSttUsage(d, "u1", -5)).toBe(false);
    const r = await rows(d);
    expect(r.map((x) => [x.user_id, x.feature, x.units])).toEqual([
      ["u1", "speech.stt.local", 60],
      ["u1", "speech.stt.local", 120],
    ]);
    expect(r[0].usd_micro).toBeCloseTo(513, 0); // 0.000513 USD per minute
  });
});

describe("the break-glass CLI that adds a speech server (scripts/local-stt/stt-worker-add.ts)", () => {
  const KEY = "C".repeat(43);
  it("checks every value, then its SQL adds the row and its audit line", async () => {
    expect(() => parseWorkerArgs(["--id", "Mac!", "--key", KEY])).toThrow("--id");
    expect(() => parseWorkerArgs(["--id", "mac", "--key", "x"])).toThrow("--key");
    expect(() => parseWorkerArgs(["--id", "mac", "--key", KEY, "--name", "a;DROP"])).toThrow(
      "--name",
    );
    expect(() => parseWorkerArgs(["--id", "mac", "--key", KEY, "--capacity", "99"])).toThrow(
      "--capacity",
    );
    const a = parseWorkerArgs([
      "--id",
      "mac",
      "--key",
      KEY,
      "--name",
      "Owner's Mac",
      "--capacity",
      "3",
    ]);
    const d = createTestD1(testSchema()) as unknown as SttDb & {
      exec(q: string): Promise<unknown>;
    };
    await d.exec(workerAddSql(a, 7));
    expect(await sttWorkerByKey(d, KEY)).toMatchObject({
      id: "mac",
      name: "Owner's Mac",
      capacity: 3,
      createdBy: "cli",
    });
    const audit = await d
      .prepare("SELECT kind, subject FROM security_audit WHERE kind = 'stt-worker.add'")
      .bind()
      .all();
    expect(audit.results).toEqual([{ kind: "stt-worker.add", subject: "mac" }]);

    // One account's own speech server (--owner): never an email, and the row says whose.
    expect(a.owner).toBeNull();
    expect(() => parseWorkerArgs(["--id", "own", "--key", KEY, "--owner", "a@b.c"])).toThrow(
      "--owner",
    );
    const own = parseWorkerArgs(["--id", "own", "--key", KEY, "--owner", "acct_9"]);
    const d2 = createTestD1(testSchema()) as unknown as SttDb & {
      exec(q: string): Promise<unknown>;
    };
    await d2.exec(workerAddSql(own, 8));
    expect(await sttWorkerByKey(d2, KEY)).toMatchObject({ id: "own", ownerUserId: "acct_9" });
  });

  it("runs wrangler d1 against production (or --local), and says why when it fails", () => {
    const said: string[] = [];
    const out = { log: (s: string) => said.push(s), error: (s: string) => said.push(`! ${s}`) };
    const cmds: string[][] = [];
    const ok = (c: string[]) => (cmds.push(c), { exitCode: 0 });
    expect(addWorker(["--id", "mac", "--key", KEY], ok, 1, out)).toBe(0);
    expect(cmds[0].slice(0, 6)).toEqual([
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "lianki",
      "--remote",
    ]);
    expect(addWorker(["--id", "mac", "--key", KEY, "--local"], ok, 1, out)).toBe(0);
    expect(cmds[1][5]).toBe("--local");
    expect(addWorker(["--id", "mac", "--key", KEY], () => ({ exitCode: 1 }), 1, out)).toBe(1);
    expect(addWorker(["--id", "Bad"], ok, 1, out)).toBe(1);
    expect(said).toEqual([
      "added speech server mac",
      "added speech server mac",
      "! wrangler exited 1",
      "! --id: a short lower-case slug (a-z, 0-9, -)",
    ]);
  });

  it("--owner writes the peer-owner file for server.py, readable by this user only", () => {
    const dir = mkdtempSync(join(tmpdir(), "stt-owner-"));
    try {
      const path = join(dir, "lianki-stt", "peer-owner");
      writeOwner("acct_9", path);
      expect(readFileSync(path, "utf8")).toBe("acct_9\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeOwner("acct_10", path); // a second run replaces it
      expect(readFileSync(path, "utf8")).toBe("acct_10\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SttRegistry: the rest of a session's life", () => {
  async function live(o: { now?: () => number; sessions?: Record<string, unknown> } = {}) {
    const k = await edKeys();
    const s = setup({ workers: { [k.pub]: { id: "mac", ownerUserId: null, capacity: null } } });
    const sessions = { ...s.sessions, ...o.sessions };
    const reg = new SttRegistry(
      s.state as never,
      { SESSIONS: sessions as never, PARTNER_TICKET_PUB: k.pub },
      o.now,
    );
    await reg.fetch(new Request(`https://lianki.com${STT_WORKER_PATH}`));
    const worker = s.sockets[0].ws;
    await reg.webSocketMessage(
      worker as never,
      JSON.stringify({
        t: "auth",
        key: k.pub,
        sig: await sign(k.priv, JSON.parse(worker.sent[0]).nonce),
      }),
    );
    const { ticket } = await signSttTicketV2(k.ticketKey, {
      sub: "u1",
      lim: { utt: 40, sess: 60 },
    });
    const r = await reg.fetch(
      new Request(`https://lianki.com${STT_SIGNAL_PATH}`, {
        headers: {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `lianki-stt2, ${ticket}`,
        },
      }),
    );
    expect(r.status).toBe(101);
    const page = s.sockets[1].ws;
    return { reg, s, k, worker, page, sid: page.last().sid as string };
  }

  it("ICE both ways, the worker's end, garbage ignored", async () => {
    const { reg, worker, page, sid } = await live();
    await reg.webSocketMessage(
      page as never,
      JSON.stringify({ t: "ice", candidate: { candidate: "p" } }),
    );
    expect(worker.last()).toEqual({ t: "ice", sid, candidate: { candidate: "p" } });
    await reg.webSocketMessage(
      worker as never,
      JSON.stringify({ t: "ice", sid, candidate: { candidate: "w" } }),
    );
    expect(page.last()).toEqual({ t: "ice", candidate: { candidate: "w" } });
    const n = page.sent.length;
    await reg.webSocketMessage(page as never, "not json");
    await reg.webSocketMessage(page as never, new ArrayBuffer(4));
    await reg.webSocketMessage(
      worker as never,
      JSON.stringify({ t: "answer", sid: "bad sid!", sdp: "x" }),
    );
    expect(page.sent.length).toBe(n);
    await reg.webSocketMessage(worker as never, JSON.stringify({ t: "end", sid, reason: "busy" }));
    expect(page.last()).toEqual({ t: "end", reason: "busy" });
    expect(page.closed).toBe(1000);
  });

  it("a page closing tells its worker; a worker going away ends its pages", async () => {
    const a = await live();
    a.reg.webSocketClose(a.page as never, 1005);
    expect(a.worker.last()).toEqual({ t: "close", sid: a.sid });
    expect(a.page.closed).toBe(1000);
    const b = await live();
    b.reg.webSocketError(b.worker as never);
    expect(b.page.last()).toEqual({ t: "end", reason: "worker-gone" });
    expect(b.page.closed).toBe(1012);
  });

  it("a session past its signed length is closed when next counted", async () => {
    let t = Date.now();
    const a = await live({ now: () => t });
    t += 61_000 + 60_000;
    // The next page of the same account counts, and finds the old one over.
    const { ticket } = await signSttTicketV2(a.k.ticketKey, {
      sub: "u1",
      lim: { utt: 40, sess: 60 },
      now: t,
    });
    const r = await a.reg.fetch(
      new Request(`https://lianki.com${STT_SIGNAL_PATH}`, {
        headers: {
          origin: "https://lianki.com",
          "sec-websocket-protocol": `lianki-stt2, ${ticket}`,
        },
      }),
    );
    expect(a.page.closed).toBe(4408);
    expect(r.status).toBe(101); // the old one no longer counts against sessionsPerAccount
  });

  it("failures read as no: config, booking, unknown paths, no key, an attachment that throws", async () => {
    const a = await live({
      sessions: {
        config: async () => {
          throw new Error("d1");
        },
        bookStt: async () => {
          throw new Error("d1");
        },
      },
    });
    await a.reg.webSocketMessage(
      a.worker as never,
      JSON.stringify({ t: "usage", sid: a.sid, audioMs: 10 }),
    );
    expect(
      (await a.reg.fetch(new Request("https://lianki.com/api/version/stt/other"))).status,
    ).toBe(404);
    const s = setup();
    const noKey = new SttRegistry(s.state as never, {});
    const req = new Request(`https://lianki.com${STT_SIGNAL_PATH}`, {
      headers: { origin: "https://lianki.com", "sec-websocket-protocol": "lianki-stt2, x.y" },
    });
    expect((await noKey.fetch(req)).status).toBe(401);
    const badKey = new SttRegistry(s.state as never, { PARTNER_TICKET_PUB: "!!" });
    expect((await badKey.fetch(req)).status).toBe(401);
    const odd = {
      send() {},
      close() {},
      deserializeAttachment: () => {
        throw new Error("x");
      },
    };
    await a.reg.webSocketMessage(odd as never, "{}");
    a.reg.webSocketClose(odd as never, 1000);
  });

  it("a worker that speaks before proving itself is closed", async () => {
    const s = setup();
    const reg = new SttRegistry(s.state as never, {});
    await reg.fetch(new Request(`https://lianki.com${STT_WORKER_PATH}`));
    await reg.webSocketMessage(s.sockets[0].ws as never, JSON.stringify({ t: "answer" }));
    expect(s.sockets[0].ws.closed).toBe(4401);
  });
});
