import { describe, expect, it } from "bun:test";
import {
  parsePageChatHttpInput as parse,
  readPageChatHttpInput as read,
  PAGE_CHAT_HTTP_MAX_BYTES,
} from "../lib/page-chat-http-wire";
describe("the CSP chat HTTP contract", () => {
  it("allows only hello, bounded site history and a user text message", () => {
    expect(parse({ op: "hello" })).toEqual({ op: "hello" });
    expect(parse({ op: "read" })).toEqual({ op: "read", wait: false });
    expect(parse({ op: "read", afterSeq: 12, wait: true })).toEqual({
      op: "read",
      afterSeq: 12,
      wait: true,
    });
    expect(parse({ op: "send", id: "client-message-1", text: "  Hello  " })).toEqual({
      op: "send",
      id: "client-message-1",
      text: "Hello",
    });
  });
  it("refuses arbitrary operations, another account/thread, tokens, eval, settings and metadata", () => {
    for (const op of [
      "eval",
      "token",
      "settings",
      "payment",
      "pair",
      "read-ack",
      "ask",
      "say",
      "avatar",
      "lane",
    ])
      expect(parse({ op })).toBeNull();
    for (const key of [
      "thread",
      "userId",
      "owner",
      "token",
      "authorization",
      "code",
      "context",
      "page",
      "label",
      "role",
    ]) {
      expect(parse({ op: "read", [key]: "synthetic" })).toBeNull();
      expect(
        parse({ op: "send", id: "client-message-1", text: "hello", [key]: "synthetic" }),
      ).toBeNull();
      expect(parse({ op: "hello", [key]: "synthetic" })).toBeNull();
    }
  });
  it("rejects invalid windows and oversized or empty messages", () => {
    for (const afterSeq of [-1, NaN, Infinity, 0.5, "1", Number.MAX_SAFE_INTEGER + 1])
      expect(parse({ op: "read", afterSeq })).toBeNull();
    expect(parse({ op: "read", wait: "true" })).toBeNull();
    expect(parse({ op: "send", id: "short", text: "hello" })).toBeNull();
    expect(parse({ op: "send", id: "client-message-1", text: " " })).toBeNull();
    expect(parse({ op: "send", id: "client-message-1", text: "x".repeat(4001) })).toBeNull();
    for (const value of [null, [], false, "read"]) expect(parse(value)).toBeNull();
  });
  it("reads JSON without trusting missing or false length metadata", async () => {
    expect(
      await read(
        new Request("https://lianki.test", {
          method: "POST",
          body: JSON.stringify({ op: "hello" }),
        }),
      ),
    ).toEqual({ op: "hello" });
    expect(
      await read(new Request("https://lianki.test", { method: "POST", body: "{" })),
    ).toBeNull();
    expect(await read(new Request("https://lianki.test", { method: "POST" }))).toBeNull();
    expect(
      await read(
        new Request("https://lianki.test", {
          method: "POST",
          headers: { "content-length": String(PAGE_CHAT_HTTP_MAX_BYTES + 1) },
          body: "{}",
        }),
      ),
    ).toBe("too-large");
    expect(
      await read(
        new Request("https://lianki.test", {
          method: "POST",
          headers: { "content-length": "junk" },
          body: "{}",
        }),
      ),
    ).toBe("too-large");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(PAGE_CHAT_HTTP_MAX_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(
      await read(
        new Request("https://lianki.test", { method: "POST", body, duplex: "half" } as RequestInit),
      ),
    ).toBe("too-large");
    expect(cancelled).toBe(true);
    expect(
      await read(
        new Request("https://lianki.test", { method: "POST", body: new Uint8Array([255]) }),
      ),
    ).toBeNull();
  });
});
