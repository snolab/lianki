import { expect, test } from "bun:test";
import {
  TokenChat,
  tokenAtt,
  validReadWindow,
  type TokenHost,
  type TokenSocket,
} from "../workers/push/src/token-chat";
import type { ChatMessage, ChatReplayRange, EditedEvent } from "../packages/debug-chat/src/wire";

const TOKEN = `lk_${"a".repeat(64)}`;
class Socket implements TokenSocket {
  sent: any[] = [];
  readyState = 1;
  attachment: any;
  closed?: number;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code?: number) {
    this.closed = code;
    this.readyState = 3;
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
}
function fixture(owner = false) {
  const sockets: Socket[] = [];
  const calls: any[] = [];
  const kv = new Map<string, unknown>();
  let denied = false;
  const thread = owner ? "owner" : "uAlice";
  const line: ChatMessage = {
    id: "line",
    seq: 4,
    from: "agent",
    label: "other",
    text: "visible",
    at: 1,
    via: "token",
    tokenLane: "other",
    answer: { at: 1, choices: {}, source: "tap", thread, label: "page" },
  };
  const range: ChatReplayRange = {
    type: "history",
    thread,
    messages: [line],
    removed: [{ id: "gone", seq: 3 }],
    afterSeq: 1,
    throughSeq: 4,
    headSeq: 9,
    prunedThroughSeq: 0,
    skipped: [{ from: 2, to: 2 }],
  };
  const host: TokenHost = {
    now: () => 10_000,
    sockets: () => sockets,
    rpc: () => ({
      chatToken: async (request) => {
        calls.push({ auth: request.op });
        return denied
          ? { ok: false, error: "expired" }
          : {
              ok: true,
              userId: "uAlice",
              owner,
              id: "a".repeat(64),
              tag: "a".repeat(16),
              lane: "reader",
              expiresAt: null,
            };
      },
    }),
    kv: {
      get: async <T>(key: string) => kv.get(key) as T | undefined,
      put: async (key, value) => {
        kv.set(key, value);
      },
    },
    post: async () => {},
    blocked: async () => false,
    history: async () => [line],
    replay: async (...args) => {
      calls.push({ replay: args });
      return range;
    },
    acknowledgeRead: async (...args) => {
      calls.push({ ack: args });
      return Math.min(args[2], 9);
    },
  };
  const chat = new TokenChat(host);
  const req = (body: unknown, token = TOKEN) =>
    chat.http(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  const socket = async (extra: Record<string, unknown> = {}) => {
    const ws = new Socket();
    sockets.push(ws);
    chat.opened(ws);
    await chat.message(ws, tokenAtt(ws)!, JSON.stringify({ type: "auth", token: TOKEN, ...extra }));
    return ws;
  };
  return {
    chat,
    host,
    req,
    calls,
    range,
    thread,
    socket,
    kv,
    deny: () => {
      denied = true;
    },
  };
}

test("HTTP replay and explicit read acknowledgements are scoped by verified identity, never supplied thread", async () => {
  const h = fixture();
  const read = await h.req({ op: "read", afterSeq: 1, throughSeq: 4, thread: "victim" });
  expect(read.status).toBe(200);
  const body = (await read.json()) as any;
  expect(body.thread).toBe("own");
  expect(body.removed).toEqual([{ id: "gone", seq: 3 }]);
  expect(body.messages[0].answer).toBeUndefined();
  expect(h.calls.find((call) => call.replay).replay).toEqual([h.thread, 1, 4, 30]);
  expect(h.calls.some((call) => call.ack)).toBe(false); // Fetching is not consumption.
  const receipt = await h.req({
    op: "read-ack",
    lastReadSeq: 999,
    thread: "victim",
    identity: "page:victim",
  });
  expect(await receipt.json()).toEqual({ ok: true, thread: "own", lastReadSeq: 9 });
  expect(h.calls.find((call) => call.ack).ack).toEqual([h.thread, `token:${"a".repeat(16)}`, 999]);
  expect(h.kv.get(`part:${"a".repeat(16)}`)).toMatchObject({ thread: h.thread, seenAt: 10_000 });
});

test("invalid windows, unavailable hosts and unauthenticated receipts never pretend acceptance", async () => {
  const h = fixture();
  expect(validReadWindow(undefined, undefined)).toBe(true);
  for (const [after, through] of [
    [undefined, 1],
    [-1, 3],
    [2, 1],
    [1, Infinity],
    ["1", 3],
  ])
    expect(validReadWindow(after, through)).toBe(false);
  for (const lastReadSeq of [-1, 1.5, "9", null, Number.MAX_SAFE_INTEGER + 1])
    expect((await h.req({ op: "read-ack", lastReadSeq })).status).toBe(400);
  expect((await h.req({ op: "read", throughSeq: 2 })).status).toBe(400);
  expect((await h.req({ op: "read-ack", lastReadSeq: 2 }, "bad")).status).toBe(401);
  expect(h.calls).toEqual([]);
  delete h.host.replay;
  delete h.host.acknowledgeRead;
  expect((await h.req({ op: "read", afterSeq: 1 })).status).toBe(503);
  expect((await h.req({ op: "read-ack", lastReadSeq: 1 })).status).toBe(503);
  const legacy = await h.req({ op: "read" });
  expect(legacy.status).toBe(200);
  expect(((await legacy.json()) as any).messages[0].answer).toBeUndefined();
});

test("socket reconnect replays full batches and passive history does not advance read receipts", async () => {
  const h = fixture();
  const ws = await h.socket({ afterSeq: 1, thread: "victim" });
  expect(h.calls.find((call) => call.replay).replay).toEqual([h.thread, 1, undefined, undefined]);
  expect(ws.sent.find((m) => m.type === "history").messages[0].answer).toBeUndefined();
  expect(h.calls.some((call) => call.ack)).toBe(false);
  await h.chat.message(
    ws,
    tokenAtt(ws)!,
    JSON.stringify({ type: "replay", afterSeq: 1, throughSeq: 4, thread: "victim" }),
  );
  await h.chat.message(
    ws,
    tokenAtt(ws)!,
    JSON.stringify({ type: "read-ack", lastReadSeq: 4, identity: "victim" }),
  );
  expect(h.calls.find((call) => call.ack).ack).toEqual([h.thread, `token:${"a".repeat(16)}`, 4]);
  expect(ws.sent.at(-1)).toEqual({ type: "read-ack", lastReadSeq: 4 });
  const count = h.calls.length;
  await h.chat.message(ws, tokenAtt(ws)!, JSON.stringify({ type: "replay", throughSeq: 4 }));
  await h.chat.message(ws, tokenAtt(ws)!, JSON.stringify({ type: "read-ack", lastReadSeq: -1 }));
  expect(h.calls).toHaveLength(count);
  h.deny();
  await h.chat.message(ws, tokenAtt(ws)!, JSON.stringify({ type: "read-ack", lastReadSeq: 7 }));
  expect(ws.closed).toBe(4401);
  expect(h.calls.filter((call) => call.ack)).toHaveLength(1);
});

test("through-only auth windows are rejected before ready; missing callbacks return errors", async () => {
  const h = fixture();
  const invalid = await h.socket({ history: 10, throughSeq: -1 });
  expect(invalid.closed).toBe(4401);
  expect(invalid.sent.some((m) => m.type === "ready")).toBe(false);
  expect(h.calls).toEqual([]);
  delete h.host.replay;
  delete h.host.acknowledgeRead;
  const ws = await h.socket({ afterSeq: 1 });
  expect(ws.sent.at(-1)).toEqual({ type: "error", error: "unavailable" });
  await h.chat.message(ws, tokenAtt(ws)!, JSON.stringify({ type: "replay", afterSeq: 1 }));
  expect(ws.sent.at(-1)).toEqual({ type: "error", error: "unavailable" });
  await h.chat.message(ws, tokenAtt(ws)!, JSON.stringify({ type: "read-ack", lastReadSeq: 2 }));
  expect(ws.sent.at(-1)).toEqual({ type: "error", error: "unavailable" });
});

test("full edited snapshots retain existing per-lane answer privacy", async () => {
  const h = fixture(true);
  const ws = await h.socket();
  await h.chat.edited({
    type: "edited",
    id: "line",
    thread: "owner",
    text: "visible",
    raw: "visible",
    edited: { at: 1, by: "auto", count: 1 },
    message: h.range.messages[0],
  } as EditedEvent);
  expect(ws.sent.at(-1).message.answer).toBeUndefined();
  expect(ws.sent.at(-1).message.seq).toBe(4);
});
