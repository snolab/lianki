/**
 * `lianki chat attachment get <id>` (owner, 2026-11-26): a chat token
 * (chat:read, never eval) gets a single-use 60 s ticket for a file posted on a
 * line of its own thread, owned by that thread's account, end to end: the hub
 * (token-chat.ts), the real token check (lib/chat-token.ts), the ownership
 * checks (lib/inbox/thread-files.ts, thread-ticket.ts) and the download
 * (lib/inbox/handlers.ts) over one TestD1 database.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { createToken, type ScopeId } from "@/lib/api-tokens";
import { chatTokenCheck, type ChatTokenDb } from "@/lib/chat-token";
import { type InboxBucket, type InboxDeps, download, storeUpload } from "@/lib/inbox/handlers";
import type { InboxDb } from "@/lib/inbox/store";
import { threadFilesOp } from "@/lib/inbox/thread-files";
import { threadTicketOp } from "@/lib/inbox/thread-ticket";
import { inboxOp } from "@/lib/inbox/agent";

const SCHEMA = testSchema();
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-26T15:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OWNER = { userId: "uOwner", email: "owner@example.com" };
const ALICE = { userId: "uAlice", email: "alice@example.com" };
const BOB = { userId: "uBob", email: "bob@example.com" };
const CHAT: ScopeId[] = ["chat:read", "chat:write"];

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
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
      let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

function memBucket(): InboxBucket {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key, body) {
      store.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
    },
    async get(key) {
      const v = store.get(key);
      return v ? { body: new Response(v as Uint8Array<ArrayBuffer>).body! } : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

let d1: TestD1Database;
let t: number;
let bucket: InboxBucket;
const db = () => d1 as unknown as ChatTokenDb & InboxDb;
beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  t = T0;
  bucket = memBucket();
  const raw = d1.raw();
  for (const u of [OWNER, ALICE, BOB])
    raw
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
      )
      .run(u.userId, u.email);
  raw.prepare("DELETE FROM account_permission").run();
  raw
    .prepare(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES (?, 'dev', 'test', 1)",
    )
    .run(OWNER.email);
});

const deps = (who: { userId: string; email: string } | null): InboxDeps => ({
  who: async () => (who ? { id: who.userId, email: who.email, owner: false } : null),
  db,
  bucket: () => bucket,
  now: () => t,
});
/** One of `who`'s chat images, stored (not yet on any line). */
const stored = async (who: { userId: string; email: string }) => {
  const r = await storeUpload(
    new Request("https://lianki.com/api/my/inbox", {
      method: "POST",
      headers: {
        "content-length": String(PNG.length),
        "x-file-name": "photo.png",
        "content-type": "image/png",
      },
      body: PNG as Uint8Array<ArrayBuffer>,
    }),
    { id: who.userId },
    deps(who),
    "chat",
  );
  return ((await r.json()) as { id: string }).id;
};
const mint = async (who: typeof OWNER, scopes = CHAT) =>
  (await createToken(db(), who, { name: "agy", scopes, expiresAt: new Date(t + 30 * DAY) }, t))
    .token;

function hubSetup() {
  const asked: unknown[] = [];
  const sockets: FakeSocket[] = [];
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    },
    {
      SESSIONS: {
        live: async () => "gone",
        chatToken: (req: unknown) => chatTokenCheck(db(), req, t),
        threadFiles: (req: unknown) => threadFilesOp(db(), req),
        threadTicket: (req: unknown) => {
          asked.push(req);
          return threadTicketOp(db(), req, { now: () => t });
        },
      },
    },
    () => t,
  );
  const http = async (token: string, body: unknown) => {
    const r = await hub.fetch(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  /** A line from `who`'s page in their own thread, with these file ids. */
  const post = async (who: { userId: string; email: string }, ids: string[], owner = false) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), {
      ...who,
      owner,
    });
    const attachments = ids.map((id) => ({ id, name: "x.png", type: "image/png", size: 1 }));
    await hub.webSocketMessage(
      ws,
      JSON.stringify({ type: "chat", id: `l${t}`, text: "look", attachments }),
    );
  };
  return { http, post, asked };
}

const fetchWith = (
  id: string,
  ticket: string,
  who: { userId: string; email: string } | null = null,
) =>
  download(
    new Request("https://lianki.com", { headers: { "x-inbox-ticket": ticket } }),
    id,
    deps(who),
  );

describe("chat attachment get", () => {
  it("a file on a line of the token's own thread: a ticket, the bytes once, then never again", async () => {
    const h = hubSetup();
    const id = await stored(ALICE);
    await h.post(ALICE, [id]);
    const r = await h.http(await mint(ALICE), { op: "attachment", id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      item: { id, name: "photo.png", type: "image/png", size: PNG.length },
      path: `/api/my/inbox/${id}`,
      header: "x-inbox-ticket",
    });
    expect(r.body.exp).toBe(T0 + 60_000);
    const ticket = r.body.ticket as string;
    const got = await fetchWith(id, ticket);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    // Single use.
    expect((await fetchWith(id, ticket)).status).toBe(404);
  });

  it("an expired ticket is refused", async () => {
    const h = hubSetup();
    const id = await stored(ALICE);
    await h.post(ALICE, [id]);
    const r = await h.http(await mint(ALICE), { op: "attachment", id });
    t = T0 + 60_001;
    expect((await fetchWith(id, r.body.ticket as string)).status).toBe(404);
  });

  it("an id not on a line of the token's thread is refused, and the main Worker is never asked", async () => {
    const h = hubSetup();
    const id = await stored(ALICE); // stored, never sent
    const r = await h.http(await mint(ALICE), { op: "attachment", id });
    expect(r.status).toBe(404);
    expect(h.asked).toEqual([]);
  });

  it("a cross-thread id: another account's file, even on a line it can see, is refused", async () => {
    const h = hubSetup();
    const alices = await stored(ALICE);
    await h.post(ALICE, [alices]);
    // Bob's token: Alice's line is not in Bob's thread.
    expect((await h.http(await mint(BOB), { op: "attachment", id: alices })).status).toBe(404);
    // Bob pastes Alice's id on his own line: the hub drops it (not his file)...
    await h.post(BOB, [alices]);
    expect((await h.http(await mint(BOB), { op: "attachment", id: alices })).status).toBe(404);
    expect(h.asked).toEqual([]);
    // ...and the main Worker refuses it anyway, whatever the hub said.
    expect(await threadTicketOp(db(), { userId: BOB.userId, owner: false, id: alices })).toEqual({
      ok: false,
      error: "no such item",
    });
    // An account that is not an owner cannot claim the owner thread.
    expect(await threadTicketOp(db(), { userId: ALICE.userId, owner: true, id: alices })).toEqual({
      ok: false,
      error: "no such item",
    });
  });

  it("the owner thread: the owner's lane token reads the owner's file", async () => {
    const h = hubSetup();
    const id = await stored(OWNER);
    await h.post(OWNER, [id], true);
    const r = await h.http(await mint(OWNER), { op: "attachment", id });
    expect(r.status).toBe(200);
    expect((await fetchWith(id, r.body.ticket as string)).status).toBe(200);
  });

  it("chat permissions only: a token without chat:read is refused", async () => {
    const h = hubSetup();
    const id = await stored(ALICE);
    await h.post(ALICE, [id]);
    expect((await h.http(await mint(ALICE, ["chat:write"]), { op: "attachment", id })).status).toBe(
      403,
    );
    expect(h.asked).toEqual([]);
  });

  it("a malformed id is refused before any check", async () => {
    const h = hubSetup();
    expect((await h.http(await mint(ALICE), { op: "attachment", id: "../etc" })).status).toBe(400);
  });

  it("a chat token's ticket and an agent's are kept apart", async () => {
    const id = await stored(ALICE);
    // An agent's inbox op does not reach a non-owner's file at all.
    expect(await inboxOp(db(), { op: "get", id }, { now: () => t })).toEqual({
      ok: false,
      error: "no such item",
    });
    const own = await stored(OWNER);
    const agent = (await inboxOp(db(), { op: "get", id: own }, { now: () => t })) as {
      ticket: string;
    };
    // An agent ticket on the owner's file still works as before.
    expect((await fetchWith(own, agent.ticket)).status).toBe(200);
  });
});
