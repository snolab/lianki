import { test, expect } from "bun:test";
import { sitePageReadBridge } from "../src/site-page-read";
import type { ChatGmRequest } from "../src/page-chat-fetch";
function fixture(opts: { enabled?: boolean; text?: string; consumeError?: boolean } = {}) {
  let selections = 0;
  const calls: Parameters<ChatGmRequest>[0][] = [];
  const doc = {
    location: new URL("https://example.test/article?private=never-send#section"),
    title: "Selected page",
    getSelection: () => {
      selections++;
      return { toString: () => opts.text ?? "Chosen text" };
    },
  } as unknown as Document;
  const request: ChatGmRequest = (details) => {
    calls.push(details);
    const action = JSON.parse(details.data!);
    const result =
      action.op === "status"
        ? {
            ok: true,
            kind: "grant",
            grant: {
              origin: "https://example.test",
              scope: "page.read",
              enabled: opts.enabled !== false,
              revision: 5,
            },
            accountBinding: "A".repeat(22),
          }
        : opts.consumeError
          ? { ok: false, error: "denied" }
          : { ok: true, kind: "selection", selection: action.selection, revision: 5 };
    queueMicrotask(() =>
      details.onload({
        status: 200,
        responseText: JSON.stringify({ ...result, secret: "not-forwarded" }),
      }),
    );
    return { abort() {} };
  };
  return { doc, request, calls, selections: () => selections };
}
test("does nothing until explicit invocation, checks current exact-site permission before reading, and never sends automatically", async () => {
  const f = fixture(),
    bridge = sitePageReadBridge({
      appOrigin: "https://lianki.com",
      doc: f.doc,
      request: f.request,
    });
  expect(f.calls).toHaveLength(0);
  expect(f.selections()).toBe(0);
  const result = await bridge.readSelection();
  expect(result).toEqual({
    ok: true,
    selection: { text: "Chosen text", title: "Selected page", url: "https://example.test/article" },
  });
  expect(f.calls.map((x) => JSON.parse(x.data!).op)).toEqual(["status", "consume"]);
  expect(f.selections()).toBe(1);
  expect(
    f.calls.every(
      (x) =>
        x.url === "https://lianki.com/api/chat/site-page-read" &&
        x.withCredentials &&
        !("Authorization" in x.headers),
    ),
  ).toBe(true);
  expect(f.calls[1].headers["x-lianki-site-account"]).toBe("A".repeat(22));
  expect(f.calls[1].data).not.toContain("private=");
});
test("denial reads no selection, empty selection is not sent, and a concurrent revoke returns a first-party settings link", async () => {
  const denied = fixture({ enabled: false });
  const b = sitePageReadBridge({
    appOrigin: "https://lianki.com",
    doc: denied.doc,
    request: denied.request,
  });
  expect(await b.readSelection()).toMatchObject({
    ok: false,
    error: "denied",
    settingsUrl: "https://lianki.com/chat/sites?origin=https%3A%2F%2Fexample.test",
  });
  expect(denied.selections()).toBe(0);
  const empty = fixture({ text: "  " });
  expect(
    await sitePageReadBridge({
      appOrigin: "https://lianki.com",
      doc: empty.doc,
      request: empty.request,
    }).readSelection(),
  ).toMatchObject({ ok: false, error: "empty" });
  expect(empty.calls).toHaveLength(1);
  const revoked = fixture({ consumeError: true });
  expect(
    await sitePageReadBridge({
      appOrigin: "https://lianki.com",
      doc: revoked.doc,
      request: revoked.request,
    }).readSelection(),
  ).toMatchObject({ ok: false, error: "denied" });
});
test("abort, bad app origin and malformed transport fail closed without capturing or sending selected text", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  expect(
    await sitePageReadBridge({
      appOrigin: "https://lianki.com",
      doc: f.doc,
      request: f.request,
    }).readSelection(controller.signal),
  ).toMatchObject({ ok: false, error: "cancelled" });
  expect(
    await sitePageReadBridge({
      appOrigin: "https://evil.test",
      doc: f.doc,
      request: f.request,
    }).readSelection(),
  ).toMatchObject({ ok: false, error: "unavailable" });
  expect(f.calls).toHaveLength(0);
  const bad: ChatGmRequest = (d) => {
    d.onload({ status: 200, responseText: "not json" });
  };
  expect(
    await sitePageReadBridge({
      appOrigin: "https://lianki.com",
      doc: f.doc,
      request: bad,
    }).readSelection(),
  ).toMatchObject({ ok: false, error: "unavailable" });
  expect(f.selections()).toBe(0);
});

test("transport error, timeout and synchronous failure never read selection; cancellation aborts pending GM work", async () => {
  const f = fixture();
  for (const mode of ["error", "timeout", "throw"] as const) {
    const request: ChatGmRequest = (d) => {
      if (mode === "throw") throw Error("synthetic");
      if (mode === "error") d.onerror();
      else d.ontimeout();
    };
    expect(
      await sitePageReadBridge({
        appOrigin: "https://lianki.com",
        doc: f.doc,
        request,
      }).readSelection(),
    ).toMatchObject({ ok: false, error: "unavailable" });
  }
  let aborts = 0;
  const pending: ChatGmRequest = () => ({
    abort() {
      aborts++;
    },
  });
  const controller = new AbortController();
  const result = sitePageReadBridge({
    appOrigin: "https://lianki.com",
    doc: f.doc,
    request: pending,
  }).readSelection(controller.signal);
  controller.abort();
  expect(await result).toMatchObject({ ok: false, error: "cancelled" });
  expect(aborts).toBe(1);
  expect(f.selections()).toBe(0);
});
