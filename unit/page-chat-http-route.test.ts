import { expect, test } from "bun:test";
import { pageChatHttp, type PageChatHttpDeps } from "../lib/page-chat-http-route";
import { threadHashKey } from "../lib/li-thread";
import { PAGE_CHAT_HTTP_HEADER, PAGE_CHAT_PRINCIPAL_HEADER } from "../lib/page-chat-http-wire";
import { verifyPageChatHttpTicket } from "../lib/page-chat-http-ticket";
const action = { op: "send" as const, id: "message_http1", text: "Hello" };
async function fixture() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const calls: Request[] = [];
  const deps: PageChatHttpDeps = {
    backend: () => "d1",
    d1: () => {
      throw Error("no API token lookup");
    },
    sessionUser: async () => ({ id: "account_a", email: "viewer@example.test" }),
    isDev: async () => true,
    flags: async () => ({ "ext.pill-chat": true }),
    allow: async () => true,
    key: async () => keys.privateKey,
    threadKey: async () => threadHashKey("synthetic-http-test"),
    push: () => ({
      fetch: async (req) => {
        calls.push(req);
        return Response.json({
          ok: true,
          kind: "accepted",
          id: action.id,
          seq: 1,
          capability: "never-return",
          email: "never-return",
        });
      },
    }),
  };
  const req = (input: unknown = action, headers: Record<string, string> = {}) =>
    new Request("https://lianki.com/api/chat/page-broker", {
      method: "POST",
      headers: {
        "x-lianki-userscript": "1",
        "x-lianki-host-origin": "https://example.test",
        [PAGE_CHAT_PRINCIPAL_HEADER]: "account_a",
        ...headers,
      },
      body: JSON.stringify(input),
    });
  return { keys, calls, deps, req };
}
test("cookie broker forwards only a signed action privately and strips all upstream authority fields", async () => {
  const f = await fixture();
  const response = await pageChatHttp(f.req(), f.deps);
  expect(await response.json()).toEqual({ ok: true, kind: "accepted", id: action.id, seq: 1 });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.headers.get("cookie")).toBeNull();
  expect(f.calls[0]!.headers.get("authorization")).toBeNull();
  const claims = await verifyPageChatHttpTicket(
    f.calls[0]!.headers.get(PAGE_CHAT_HTTP_HEADER)!,
    f.keys.publicKey,
    action,
  );
  expect(claims).toMatchObject({ sub: "account_a", own: true, ho: "https://example.test" });
  expect(claims?.th).toHaveLength(22);
});
test("signed-out, changed account, bearer, missing extension header and advanced operations fail before PUSH", async () => {
  const f = await fixture();
  for (const req of [
    f.req(action, { authorization: "Bearer synthetic" }),
    f.req(action, { "x-lianki-userscript": "" }),
    f.req(action, { [PAGE_CHAT_PRINCIPAL_HEADER]: "account_b" }),
    f.req({ ...action, thread: "owner" }),
    f.req({ op: "eval", code: "1" }),
    f.req(action, { "x-lianki-host-origin": "https://example.test/private" }),
  ])
    expect((await pageChatHttp(req, f.deps)).status).toBeGreaterThanOrEqual(400);
  f.deps.sessionUser = async () => null;
  expect((await pageChatHttp(f.req(), f.deps)).status).toBe(403);
  expect(f.calls).toHaveLength(0);
});
test("hello gives only the verified account id; history omits private line metadata", async () => {
  const f = await fixture();
  expect(await (await pageChatHttp(f.req({ op: "hello" }), f.deps)).json()).toEqual({
    ok: true,
    kind: "hello",
    principal: "account_a",
  });
  expect(f.calls).toHaveLength(0);
  f.deps.push = () => ({
    fetch: async () =>
      Response.json({
        ok: true,
        kind: "history",
        ticket: "never-return",
        range: {
          type: "history",
          thread: "owner~" + "A".repeat(22),
          messages: [
            {
              id: "line1",
              text: "site text",
              from: "agent",
              at: 1,
              seq: 1,
              label: "private",
              email: "private",
              context: { selection: "private" },
              tok: "private",
            },
          ],
          removed: [],
          skipped: [],
          afterSeq: 0,
          throughSeq: 1,
          headSeq: 1,
          prunedThroughSeq: 0,
        },
      }),
  });
  const body = await (await pageChatHttp(f.req({ op: "read", wait: false }), f.deps)).json();
  expect(body.range.messages[0]).toEqual({
    id: "line1",
    text: "site text",
    from: "agent",
    at: 1,
    seq: 1,
    label: "",
    thread: "owner~" + "A".repeat(22),
  });
  expect(JSON.stringify(body)).not.toContain("private");
  expect(body.ticket).toBeUndefined();
});
