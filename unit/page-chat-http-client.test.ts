import { test, expect } from "bun:test";
import { pageChatHttpClient } from "../src/page-chat-http-client";
import type { ChatGmRequest } from "../src/page-chat-fetch";
test("privileged GM uses fixed URL, cookie-only headers, bounded action and cancellation", async () => {
  let details: Parameters<ChatGmRequest>[0] | undefined;
  let aborted = 0;
  const call = pageChatHttpClient("https://lianki.com", "https://example.test", (d) => {
    details = d;
    return {
      abort() {
        aborted++;
      },
    };
  });
  const controller = new AbortController();
  const result = call({ op: "read", wait: true }, "account_a", controller.signal);
  expect(details!.url).toBe("https://lianki.com/api/chat/page-broker");
  expect(details!.timeout).toBe(30000);
  expect(details!.headers.authorization).toBeUndefined();
  expect(details!.headers["x-lianki-chat-principal"]).toBe("account_a");
  controller.abort();
  expect(await result).toEqual({ ok: false, error: "cancelled" });
  expect(aborted).toBe(1);
  details!.onload({
    status: 200,
    responseText: JSON.stringify({ ok: true, kind: "hello", principal: "other" }),
  });
  await expect(call({ op: "eval" } as never)).rejects.toThrow("invalid");
});
test("GM transport rejects unknown origins and strips fake authority from responses", async () => {
  const request: ChatGmRequest = (d) => {
    d.onload({
      status: 200,
      responseText: JSON.stringify({
        ok: true,
        kind: "hello",
        principal: "account_a",
        token: "discard",
      }),
    });
  };
  await expect(
    pageChatHttpClient("https://other.test", "https://example.test", request)({ op: "hello" }),
  ).rejects.toThrow();
  expect(
    await pageChatHttpClient(
      "https://lianki.com",
      "https://example.test",
      request,
    )({ op: "hello" }),
  ).toEqual({ ok: true, kind: "hello", principal: "account_a" });
});
test("GM network, timeout and malformed JSON failures never fall back to page fetch", async () => {
  for (const failure of ["onerror", "ontimeout", "json"]) {
    const call = pageChatHttpClient("https://lianki.com", "https://example.test", (d) => {
      if (failure === "json") d.onload({ status: 200, responseText: "not json" });
      else d[failure as "onerror" | "ontimeout"]();
    });
    expect(await call({ op: "hello" })).toEqual({ ok: false, error: "unavailable" });
  }
  const early = new AbortController();
  early.abort();
  let calls = 0;
  expect(
    await pageChatHttpClient("https://lianki.com", "https://example.test", () => {
      calls++;
    })({ op: "hello" }, undefined, early.signal),
  ).toEqual({ ok: false, error: "cancelled" });
  expect(calls).toBe(0);
  await expect(
    pageChatHttpClient("https://lianki.com", "https://example.test", () => {
      throw Error("manager unavailable");
    })({ op: "hello" }),
  ).rejects.toThrow("manager unavailable");
});
