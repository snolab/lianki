/**
 * public/sw.js on a my-<hash> or my-<name> box (`next dev`): it must answer nothing and cache
 * nothing, and clear what an older worker cached, or the page runs the previous
 * build's chunks next to the new ones and never hydrates. On lianki.com nothing
 * changes.
 */
import { describe, expect, test } from "bun:test";
import { isBoxHost } from "@/lib/box-oauth/rules";

type Handler = (e: Record<string, unknown>) => void;

async function load(hostname: string, cached: string[]) {
  const src = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const handlers: Record<string, Handler> = {};
  const deleted: string[] = [];
  const opened: string[] = [];
  const self = {
    location: { hostname, origin: `https://${hostname}` },
    addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    keys: async () => cached,
    delete: async (k: string) => (deleted.push(k), true),
    open: async (k: string) => (
      opened.push(k), { addAll: async () => {}, put: async () => {}, match: async () => undefined }
    ),
    match: async () => undefined,
  };
  new Function("self", "caches", "fetch", src)(self, caches, async () => new Response("net"));
  const settle = async (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let answered = false;
    handlers[type]({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: () => (answered = true),
      ...extra,
    });
    await Promise.all(waits);
    return answered;
  };
  return { settle, deleted, opened };
}

const get = (url: string) => ({
  request: new Request(url, { headers: { accept: "text/html" } }),
});

describe("the service worker on a box", () => {
  test("answers nothing, caches nothing, and clears an older worker's cache", async () => {
    const host = "my-0123456789abcdef.lianki.com";
    const sw = await load(host, ["lianki-v2", "lianki-audio-v1"]);
    await sw.settle("install");
    expect(sw.opened).toEqual([]);
    await sw.settle("activate");
    expect(sw.deleted).toEqual(["lianki-v2"]);
    for (const p of ["/_next/static/chunks/a.js", "/_next/x", "/home", "/icon.png"])
      expect(await sw.settle("fetch", get(`https://${host}${p}`))).toBe(false);
  });

  test("a named box is a box too", async () => {
    const host = "my-example.lianki.com";
    const sw = await load(host, ["lianki-v2"]);
    await sw.settle("install");
    expect(sw.opened).toEqual([]);
    await sw.settle("activate");
    expect(sw.deleted).toEqual(["lianki-v2"]);
    expect(await sw.settle("fetch", get(`https://${host}/_next/static/chunks/a.js`))).toBe(false);
  });

  test("every host the box rule accepts is a box here (the worker's check is broader)", async () => {
    const hosts = [
      "my-0123456789abcdef.lianki.com",
      `my-${"a".repeat(64)}.lianki.com`,
      "my-example.lianki.com",
      "my-a1b.lianki.com",
      "my-team-2.lianki.com",
      `my-${"x".repeat(30)}.lianki.com`,
    ];
    for (const host of hosts) {
      expect(isBoxHost(host)).toBe(true);
      const sw = await load(host, []);
      await sw.settle("install");
      expect(sw.opened).toEqual([]);
    }
  });

  test("look-alikes and other hosts keep caching", async () => {
    for (const host of [
      "my-example.lianki.com.evil.com",
      "x.my-example.lianki.com",
      "dev.lianki.com",
      "localhost",
    ]) {
      const sw = await load(host, []);
      await sw.settle("install");
      expect(sw.opened).toContain("lianki-v2");
    }
  });

  test("on lianki.com it still caches and answers", async () => {
    const sw = await load("lianki.com", ["lianki-v2", "lianki-v1", "lianki-audio-v1"]);
    await sw.settle("install");
    expect(sw.opened).toContain("lianki-v2");
    await sw.settle("activate");
    expect(sw.deleted).toEqual(["lianki-v1"]);
    expect(await sw.settle("fetch", get("https://lianki.com/_next/static/chunks/a.js"))).toBe(true);
    expect(await sw.settle("fetch", get("https://lianki.com/home"))).toBe(true);
  });
});
