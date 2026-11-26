import { expect, test } from "bun:test";
import { DebugHub, type Socket, type Storage } from "../workers/push/src/debug";
import { b64url } from "../lib/stt-ticket";
import { signSiteAction, SITE_ACTION_HEADER } from "../lib/site-permission-ticket";
import { signPageChatHttpTicket } from "../lib/page-chat-http-ticket";
import { PAGE_CHAT_HTTP_HEADER, type PageChatHttpAction } from "../lib/page-chat-http-wire";
import { rpcStub } from "./support/rpc-stub";
import { pageChatHttp } from "../lib/page-chat-http-route";
import { threadHashKey } from "../lib/li-thread";
import { clearDictation, DICTATION_CLEAR_PATH } from "../lib/dictation-clear";
const NOW = 1_800_000_000_000,
  account = "account_a",
  bid = "browser_00000001",
  origin = "https://example.test",
  routeId = "window_001";

class SourceSocket implements Socket {
  readyState = 1;
  sent: any[] = [];
  attachment: any;
  constructor(user = account, id = "source_001") {
    this.attachment = {
      role: "page",
      thread: "owner",
      user,
      id,
      label: "synthetic main tab",
      session: "synthetic_session",
      sessionUntil: NOW + 3_600_000,
    };
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  last(type: string) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

async function fixture() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const data = new Map<string, unknown>(),
    sockets: SourceSocket[] = [];
  let alarm: number | null = null,
    on = true,
    live = "live";
  const tasks: Promise<unknown>[] = [];
  const storage: Storage = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key) => data.delete(key),
    list: async <T>(o: { prefix: string; limit?: number; reverse?: boolean }) => {
      let values = [...data]
        .filter(([key]) => key.startsWith(o.prefix))
        .sort(([a], [b]) => a.localeCompare(b));
      if (o.reverse) values.reverse();
      return new Map(values.slice(0, o.limit).map(([k, v]) => [k, structuredClone(v) as T]));
    },
    getAlarm: async () => alarm,
    setAlarm: async (value) => {
      alarm = value;
    },
  };
  const hub = new DebugHub(
    {
      storage,
      getWebSockets: () => sockets,
      acceptWebSocket() {},
      waitUntil: (p) => tasks.push(p),
    },
    {
      PARTNER_TICKET_PUB: pub,
      SESSIONS: rpcStub({
        live: async () => live,
        flag: async (key: string) => key === "portable.mic-route" && on,
        config: async () => undefined,
      }),
    },
    () => NOW,
  );
  const grant = async (enabled: boolean, who = account) => {
    const action = { op: "set", origin, scope: "page.dictation", enabled } as const;
    const response = await hub.fetch(
      new Request("https://lianki-push/internal/site-permissions", {
        method: "POST",
        headers: { [SITE_ACTION_HEADER]: await signSiteAction(pair.privateKey, who, action, NOW) },
        body: JSON.stringify(action),
      }),
    );
    return response.json() as Promise<any>;
  };
  const call = async (action: PageChatHttpAction, who = account, own = true) => {
    const ticket = await signPageChatHttpTicket(
      pair.privateKey,
      { sub: who, ...(own ? { own: true as const } : {}), ho: origin, th: "A".repeat(22) },
      action,
      NOW,
    );
    const response = await hub.fetch(
      new Request("https://lianki-push/internal/page-chat", {
        method: "POST",
        headers: { [PAGE_CHAT_HTTP_HEADER]: ticket },
        body: JSON.stringify(action),
      }),
    );
    return response.json() as Promise<any>;
  };
  const source = async (who = account, id = "source_001") => {
    const ws = new SourceSocket(who, id);
    sockets.push(ws);
    await hub.webSocketMessage(ws, JSON.stringify({ type: "dictation-source", bid, state: "on" }));
    return ws;
  };
  const final = async (
    ws: SourceSocket,
    gen: number,
    finalId = "final_001",
    text = "only synthetic words",
  ) => {
    await hub.webSocketMessage(
      ws,
      JSON.stringify({
        type: "chat-dictation",
        bid,
        routeId,
        gen,
        sgen: ws.last("dictation-source-ok")?.sgen,
        finalId,
        text,
        at: NOW,
      }),
    );
  };
  const http = async (input: unknown, principal = account) => {
    const response = await pageChatHttp(
      new Request("https://lianki.com/api/chat/page-broker", {
        method: "POST",
        headers: {
          "x-lianki-userscript": "1",
          "x-lianki-host-origin": origin,
          "x-lianki-chat-principal": principal,
        },
        body: JSON.stringify(input),
      }),
      {
        backend: () => "d1",
        d1: () => {
          throw Error("no API token lookup");
        },
        sessionUser: async () => ({ id: account, email: "synthetic@example.test" }),
        isDev: async () => true,
        flags: async () => ({ "ext.pill-chat": true, "portable.mic-route": on }),
        allow: async () => true,
        allowDictation: async () => true,
        key: async () => pair.privateKey,
        threadKey: async () => threadHashKey("synthetic-dictation-only"),
        now: () => NOW,
        push: () => ({ fetch: (request) => hub.fetch(request) }),
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    hub,
    http,
    data,
    sockets,
    tasks,
    grant,
    call,
    source,
    final,
    flag: (value: boolean) => {
      on = value;
    },
    live: (value: string) => {
      live = value;
    },
  };
}

test("the cookie-only public broker preserves principal, flag and single-use binding through the complete synthetic flow", async () => {
  const f = await fixture();
  await f.grant(true);
  const source = await f.source();
  const on = { op: "route", state: "on", bid, routeId } as const;
  expect((await f.http(on, "another_account")).body.error).toBe("account-changed");
  const route = await f.http(on);
  expect(route.status).toBe(200);
  expect(route.body).toMatchObject({ ok: true, kind: "route", state: "listening" });
  await f.final(source, route.body.gen);
  const read = await f.http({
    op: "read",
    wait: false,
    dictation: { bid, routeId, gen: route.body.gen },
  });
  expect(read.body.range.dictation.items[0].text).toBe("only synthetic words");
  expect(read.body.range.messages).toHaveLength(0);
  expect(JSON.stringify(read.body)).not.toContain("principal");
  f.flag(false);
  expect(
    (await f.http({ op: "route", state: "beat", bid, routeId, gen: route.body.gen })).body.error,
  ).toBe("off");
  expect(JSON.stringify([...f.data])).not.toContain("only synthetic words");
  await Promise.all(f.tasks);
});

test("actual private broker + authenticated source routes synthetic text, redelivers and confirms append without chat/storage", async () => {
  const f = await fixture();
  await f.grant(true);
  const ws = await f.source();
  expect(ws.last("dictation-source-ok")).toMatchObject({ bid, principal: account });
  const route = await f.call({ op: "route", state: "on", bid, routeId });
  expect(route).toMatchObject({ ok: true, kind: "route", state: "listening" });
  await f.final(ws, route.gen);
  const action = { op: "read", wait: false, dictation: { bid, routeId, gen: route.gen } } as const;
  const first = await f.call(action);
  expect(first.range.dictation.items).toEqual([
    { seq: 1, finalId: "final_001", text: "only synthetic words", at: NOW },
  ]);
  expect(first.range.messages).toHaveLength(0);
  expect((await f.call(action)).range.dictation).toEqual(first.range.dictation);
  expect(await f.call({ ...action, dictation: { ...action.dictation, afterSeq: 2 } })).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(
    (await f.call({ ...action, dictation: { ...action.dictation, afterSeq: 1 } })).range.dictation
      .items,
  ).toHaveLength(0);
  expect(ws.last("dictation-acked")).toEqual({ type: "dictation-acked", finalIds: ["final_001"] });
  expect(JSON.stringify([...f.data])).not.toContain("only synthetic words");
  expect(ws.sent.some((m) => m.type === "chat")).toBe(false);
  await Promise.all(f.tasks);
});

test("revoking the distinct site grant clears delivered text as uncertain and old reads cannot recover it", async () => {
  const f = await fixture();
  const ws = await f.source();
  expect((await f.call({ op: "route", state: "on", bid, routeId })).error).toBe("no-grant");
  await f.grant(true);
  const route = await f.call({ op: "route", state: "on", bid, routeId });
  await f.final(ws, route.gen);
  const action = { op: "read", wait: false, dictation: { bid, routeId, gen: route.gen } } as const;
  expect((await f.call(action)).range.dictation.items).toHaveLength(1);
  await f.grant(false);
  expect(ws.last("dictation-unconfirmed")).toEqual({
    type: "dictation-unconfirmed",
    finalIds: ["final_001"],
    why: "revoked",
  });
  expect(await f.call(action)).toEqual({ ok: false, error: "no-grant" });
  await f.grant(true);
  expect(await f.call(action)).toEqual({ ok: false, error: "stale" });
  await Promise.all(f.tasks);
});

test("source roles, live sessions, flag, browser and account are checked at the actual hub boundary", async () => {
  const f = await fixture();
  await f.grant(true);
  const source = await f.source();
  const route = await f.call({ op: "route", state: "on", bid, routeId });
  const other = await f.source("account_b", "source_002");
  await f.final(other, route.gen, "wrong_account");
  expect(
    (await f.call({ op: "read", wait: false, dictation: { bid, routeId, gen: route.gen } })).range
      .dictation.items,
  ).toHaveLength(0);
  expect(
    (
      await f.call({
        op: "read",
        wait: false,
        dictation: { bid: "browser_00000002", routeId, gen: route.gen },
      })
    ).error,
  ).toBe("stale");
  expect((await f.call({ op: "route", state: "on", bid, routeId }, "account_b", false)).error).toBe(
    "off",
  );
  const embedded = new SourceSocket(account, "embed_001");
  embedded.attachment.embed = true;
  f.sockets.push(embedded);
  await f.hub.webSocketMessage(
    embedded,
    JSON.stringify({ type: "dictation-source", bid, state: "on" }),
  );
  expect(embedded.last("dictation-source-ok")).toBeUndefined();
  f.live("gone");
  await f.final(source, route.gen, "signedout_final");
  expect(source.readyState).toBe(3);
  f.flag(false);
  expect((await f.call({ op: "route", state: "beat", bid, routeId, gen: route.gen })).error).toBe(
    "off",
  );
  await Promise.all(f.tasks);
});

test("an observed flag-off clears both queued and delivered leases before a quick re-enable", async () => {
  const f = await fixture();
  await f.grant(true);
  const source = await f.source();
  const route = await f.http({ op: "route", state: "on", bid, routeId });
  const gen = route.body.gen;
  await f.final(source, gen, "already_delivered");
  await f.http({ op: "read", wait: false, dictation: { bid, routeId, gen } });
  await f.final(source, gen, "still_queued");
  f.flag(false);
  expect((await f.http({ op: "route", state: "beat", bid, routeId, gen })).body.error).toBe("off");
  expect(source.last("dictation-returned")).toMatchObject({
    finalIds: ["still_queued"],
    why: "revoked",
  });
  expect(source.last("dictation-unconfirmed")).toMatchObject({
    finalIds: ["already_delivered"],
    why: "revoked",
  });
  f.flag(true);
  expect(
    (await f.http({ op: "read", wait: false, dictation: { bid, routeId, gen } })).body.error,
  ).toBe("stale");
  expect((await f.http({ op: "route", state: "beat", bid, routeId, gen })).body.state).toBe("off");
  const fresh = await f.http({ op: "route", state: "on", bid, routeId });
  expect(fresh.body.state).toBe("no-source");
  expect(fresh.body.gen).toBeGreaterThan(gen);
  await f.final(source, gen, "still_queued");
  expect(
    (await f.http({ op: "read", wait: false, dictation: { bid, routeId, gen: fresh.body.gen } }))
      .body.range.dictation.items,
  ).toHaveLength(0);
  await Promise.all(f.tasks);
});

test("private flag reset rejects public hosts and malformed requests, and retires all leases", async () => {
  const f = await fixture();
  await f.grant(true);
  const source = await f.source();
  const route = await f.call({ op: "route", state: "on", bid, routeId });
  await f.final(source, route.gen);
  for (const request of [
    new Request(`https://example.test${DICTATION_CLEAR_PATH}`, { method: "POST", body: "{}" }),
    new Request(`https://lianki-push${DICTATION_CLEAR_PATH}`, {
      method: "POST",
      body: JSON.stringify({ account, extra: true }),
    }),
    new Request(`https://lianki-push${DICTATION_CLEAR_PATH}`, {
      method: "POST",
      body: " ".repeat(257),
    }),
    new Request(`https://lianki-push${DICTATION_CLEAR_PATH}`),
  ])
    expect((await f.hub.fetch(request)).status).toBe(403);
  expect((await f.call({ op: "route", state: "beat", bid, routeId, gen: route.gen })).state).toBe(
    "listening",
  );
  expect(await clearDictation({ fetch: (request) => f.hub.fetch(request) })).toBe(true);
  expect(
    await f.call({ op: "read", wait: false, dictation: { bid, routeId, gen: route.gen } }),
  ).toEqual({ ok: false, error: "stale" });
  expect(source.last("dictation-returned")).toMatchObject({ finalIds: ["final_001"] });
  expect(source.last("dictation-target").target).toBeNull();
  expect(await clearDictation(null)).toBe(false);
  await Promise.all(f.tasks);
});

test("a native broker long poll wakes on a synthetic final and releases its waiter", async () => {
  const f = await fixture();
  await f.grant(true);
  const source = await f.source();
  const route = await f.call({ op: "route", state: "on", bid, routeId });
  let registered!: () => void;
  const registration = new Promise<"registered">((resolve) => {
    registered = () => resolve("registered");
  });
  const wait = (f.hub as any).waitPageHttp.bind(f.hub);
  (f.hub as any).waitPageHttp = (...args: unknown[]) => {
    const result = wait(...args);
    registered();
    return result;
  };
  const response = f.call({
    op: "read",
    afterSeq: 0,
    wait: true,
    dictation: { bid, routeId, gen: route.gen },
  });
  // Observe actual waiter registration, without a timing-dependent polling loop.
  expect(await Promise.race([registration, response])).toBe("registered");
  expect((f.hub as any).pageHttpWaiters.size).toBe(1);
  await f.final(source, route.gen);
  expect((await response).range.dictation.items[0].finalId).toBe("final_001");
  expect((f.hub as any).pageHttpWaiters.size).toBe(0);
  await Promise.all(f.tasks);
});
