import { describe, expect, test } from "bun:test";
import { DebugHub, type Storage } from "../workers/push/src/debug";
import { b64url } from "../lib/stt-ticket";
import { signPageChatHttpTicket } from "../lib/page-chat-http-ticket";
import { PAGE_CHAT_HTTP_HEADER, type PageChatHttpAction } from "../lib/page-chat-http-wire";
const NOW = 1800000000000;
async function fixture() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const data = new Map<string, unknown>();
  const storage: Storage = {
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    put: async (k, v) => {
      data.set(k, structuredClone(v));
    },
    delete: async (k) => data.delete(k),
    list: async <T>(o: { prefix: string; reverse?: boolean; limit?: number }) => {
      let rows = [...data]
        .filter(([k]) => k.startsWith(o.prefix))
        .sort(([a], [b]) => a.localeCompare(b));
      if (o.reverse) rows.reverse();
      return new Map(rows.slice(0, o.limit).map(([k, v]) => [k, structuredClone(v) as T]));
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const tasks: Promise<unknown>[] = [];
  const hub = new DebugHub(
    { storage, acceptWebSocket() {}, getWebSockets: () => [], waitUntil: (p) => tasks.push(p) },
    { PARTNER_TICKET_PUB: pub, SESSIONS: { flag: async () => false } },
    () => NOW,
  );
  const make = async (action: PageChatHttpAction, site = "A".repeat(22)) => {
    const ticket = await signPageChatHttpTicket(
      keys.privateKey,
      { sub: "account_a", own: true, ho: "https://example.test", th: site },
      action,
      NOW,
    );
    return new Request("https://lianki-push/internal/page-chat", {
      method: "POST",
      headers: { [PAGE_CHAT_HTTP_HEADER]: ticket },
      body: JSON.stringify(action),
    });
  };
  const call = async (action: PageChatHttpAction, site?: string) =>
    (await hub.fetch(await make(action, site))).json() as Promise<any>;
  return { hub, make, call, tasks, data };
}
describe("chat-only HTTP Durable Object boundary", () => {
  test("stores a user line only in its signed site; duplicate IDs cannot post or charge twice", async () => {
    const f = await fixture();
    const action = { op: "send" as const, id: "message_001", text: "Hello" };
    const results = await Promise.all([f.call(action), f.call(action)]);
    expect(results.every((x) => x.ok && x.kind === "accepted")).toBe(true);
    await Promise.all(f.tasks);
    const read = await f.call({ op: "read", wait: false });
    expect(read.range.messages).toHaveLength(1);
    expect(read.range.messages[0]).toMatchObject({ text: "Hello", from: "owner" });
    expect(read.range.thread).toBe("owner~" + "A".repeat(22));
    expect(JSON.stringify(read)).not.toContain("capability");
    expect((await f.call({ op: "read", wait: false }, "B".repeat(22))).range.messages).toHaveLength(
      0,
    );
    expect((await f.call(action)).seq).toBe(results[0].seq);
    await Promise.all(f.tasks);
  });
  test("rejects replayed capability, changed operation and public-host requests", async () => {
    const f = await fixture();
    const req = await f.make({ op: "read", wait: false });
    const copy = req.clone();
    expect((await f.hub.fetch(req)).status).toBe(200);
    expect((await f.hub.fetch(copy)).status).toBe(403);
    const changed = await f.make({ op: "read", wait: false });
    expect(
      (
        await f.hub.fetch(
          new Request(changed.url, {
            method: "POST",
            headers: changed.headers,
            body: JSON.stringify({ op: "send", id: "message_002", text: "changed" }),
          }),
        )
      ).status,
    ).toBe(403);
    const publicReq = await f.make({ op: "read", wait: false });
    expect(
      (await f.hub.fetch(new Request("https://lianki.com/internal/page-chat", publicReq))).status,
    ).toBe(403);
  });
  test("registers before replay, wakes on a durable write and cancels idle waits", async () => {
    const f = await fixture();
    const first = await f.call({ op: "read", wait: false });
    const request = await f.make({ op: "read", afterSeq: first.range.headSeq, wait: true });
    const waiting = f.hub.fetch(request);
    const sent = await f.call({ op: "send", id: "message_003", text: "Wake" });
    expect(sent.ok).toBe(true);
    expect(((await (await waiting).json()) as any).range.messages[0].text).toBe("Wake");
    await Promise.all(f.tasks);
    const controller = new AbortController();
    const next = await f.make({ op: "read", afterSeq: sent.seq, wait: true });
    const cancelled = f.hub.fetch(new Request(next, { signal: controller.signal }));
    controller.abort();
    expect((await cancelled).status).toBe(499);
  });
});
