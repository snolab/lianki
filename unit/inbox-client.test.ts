import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { inboxFiles, inboxFile, isAnkiPackage, linkInboxLine } from "@/lib/inbox/client";
import { setPublicConfig } from "@/lib/config-client";
import { stubGlobals } from "./support/globals";

class Xhr {
  static last: Xhr;
  method = "";
  url = "";
  headers = new Map<string, string>();
  body: unknown;
  status = 201;
  responseText = '{"id":"aaaaaaaaaaaaaaaaaaaa","name":"fixture.png","type":"image/png","size":3}';
  upload: { onprogress?: (e: { loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    Xhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers.set(key, value);
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}
let restore: () => void;
let fetcher: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const calls: { url: string; init?: RequestInit }[] = [];
beforeEach(() => {
  calls.length = 0;
  fetcher = async () => Response.json({ items: [] });
  restore = stubGlobals({
    XMLHttpRequest: Xhr,
    fetch: (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return fetcher(url, init);
    },
  });
});
afterEach(() => {
  restore();
  setPublicConfig({});
});
const options = { importDeck: "Import deck", go: (_path: string) => {}, account: "account-a" };
const host = () => inboxFiles(options);
const file = () => new File([new Uint8Array([1, 2, 3])], "fixture.png", { type: "image/png" });

describe("own inbox browser adapter", () => {
  it("uses the canonical private URL, account scope, live public size, and safe deck action", () => {
    setPublicConfig({ "inbox.maxFileBytes": 2048 });
    const f = host();
    expect(f.maxBytes).toBe(2048);
    expect(f.scope).toBe("account-a");
    expect(f.url({ id: "a/b" } as never)).toBe("/api/my/inbox/a%2Fb");
    const paths: string[] = [];
    const action = inboxFiles({ ...options, go: (p) => paths.push(p) }).actions!({
      id: "a/b",
      name: "deck.apkg",
    } as never);
    action[0]!.run();
    expect(paths).toEqual(["/words/import?inbox=a%2Fb"]);
    expect(f.actions!({ name: "photo.png" } as never)).toEqual([]);
    expect(isAnkiPackage("DECK.COLPKG")).toBe(true);
    expect(isAnkiPackage("deck.apkg.exe")).toBe(false);
  });
  it("uploads with progress and parses only a successful response", async () => {
    const progress: number[][] = [];
    const p = host().upload(file(), (a, b) => progress.push([a, b]), new AbortController().signal);
    expect(Xhr.last.url).toBe("/api/my/inbox");
    expect(Xhr.last.method).toBe("POST");
    expect(Xhr.last.headers.get("content-type")).toBe("image/png");
    Xhr.last.upload.onprogress?.({ loaded: 2, total: 3 });
    Xhr.last.onload?.();
    expect(await p).toMatchObject({ name: "fixture.png", size: 3 });
    expect(progress).toEqual([[2, 3]]);
  });
  it("refuses HTTP failure, bad JSON, network failure, and an abort", async () => {
    for (const mode of ["http", "json", "network", "abort"]) {
      const ac = new AbortController();
      const f = new File(["x"], "plain");
      const p = host().upload(f, () => {}, ac.signal);
      const expected = () => expect(p).rejects.toThrow();
      expect(Xhr.last.headers.get("content-type")).toBe("application/octet-stream");
      if (mode === "http") {
        Xhr.last.status = 413;
        Xhr.last.onload?.();
      }
      if (mode === "json") {
        Xhr.last.responseText = "invalid";
        Xhr.last.onload?.();
      }
      if (mode === "network") Xhr.last.onerror?.();
      if (mode === "abort") ac.abort();
      await expected();
    }
    const ac = new AbortController();
    ac.abort();
    await expect(host().upload(file(), () => {}, ac.signal)).rejects.toThrow("aborted");
  });
  it("lists only what its endpoint returns and exposes the live quota", async () => {
    const item = { id: "a", name: "fixture.png", type: "image/png", size: 3, at: 0 };
    fetcher = async () =>
      Response.json({ items: [item], usage: { bytesStored: 30, items: 1, capBytes: 100 } });
    expect(await host().list!()).toEqual({
      items: [item],
      usage: { bytes: 30, items: 1, quota: 100 },
    });
    fetcher = async () => Response.json({ items: [], usage: { bytesStored: 0, items: 0 } });
    expect(await host().list!()).toEqual({ items: [], usage: { bytes: 0, items: 0 } });
    fetcher = async () => Response.json({ items: [] });
    expect(await host().list!()).toEqual({ items: [] });
    fetcher = async () => new Response("", { status: 401 });
    await expect(host().list!()).rejects.toThrow("401");
  });
  it("deletes at an encoded own URL and reports a failed delete", async () => {
    fetcher = async () => new Response(null, { status: 204 });
    await host().remove!("a/b");
    expect(calls.at(-1)).toMatchObject({ url: "/api/my/inbox/a%2Fb", init: { method: "DELETE" } });
    fetcher = async () => new Response("", { status: 404 });
    await expect(host().remove!("x")).rejects.toThrow("404");
  });
  it("reads only valid own file IDs with safe names and preserves content type", async () => {
    const id = "a".repeat(20);
    await expect(inboxFile("../other")).rejects.toThrow("bad inbox id");
    expect(calls.length).toBe(0);
    fetcher = async () =>
      new Response("data", {
        headers: {
          "content-type": "application/zip",
          "content-disposition": "attachment; filename*=UTF-8''deck%20test.apkg",
        },
      });
    const f = await inboxFile(id);
    expect(f.name).toBe("deck test.apkg");
    expect(f.type).toBe("application/zip");
    expect(await f.text()).toBe("data");
    fetcher = async () =>
      new Response("data", {
        headers: { "content-disposition": "attachment; filename*=UTF-8''%E0%A4%A" },
      });
    expect((await inboxFile(id)).name).toBe("inbox.apkg");
    fetcher = async () => new Response(new Uint8Array([1]));
    expect((await inboxFile(id)).name).toBe("inbox.apkg");
    fetcher = async () => new Response("", { status: 404 });
    await expect(inboxFile(id)).rejects.toThrow("404");
  });
  it("links files in the own-account endpoint and swallows a failed fire-and-forget request", async () => {
    linkInboxLine([], "line");
    expect(calls.length).toBe(0);
    linkInboxLine(["a"], "line");
    expect(calls.at(-1)).toMatchObject({
      url: "/api/my/inbox",
      init: { method: "PATCH", body: '{"ids":["a"],"line":"line"}' },
    });
    fetcher = async () => {
      throw Error("offline");
    };
    linkInboxLine(["b"], "line");
    await Promise.resolve();
  });
});
