/**
 * public/sw.js hands the page a response only after its copy is in the cache
 * (keep() in sw.js). With the write left running in the background, WebKit hung
 * the next navigation of a page that left before the response finished: no
 * request reached the server (qa-sign-out, WebKit only, Full QA 2026-11-10).
 */
import { describe, expect, test } from "bun:test";

type Handler = (e: Record<string, unknown>) => void;

async function load() {
  const src = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const handlers: Record<string, Handler> = {};
  let finishPut: () => void = () => {};
  const putDone = new Promise<void>((r) => (finishPut = r));
  const puts: string[] = [];
  const self = {
    location: { hostname: "lianki.com", origin: "https://lianki.com" },
    addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({
      addAll: async () => {},
      match: async () => undefined,
      put: async (r: Request | string) => {
        puts.push(typeof r === "string" ? r : r.url);
        await putDone;
      },
    }),
    match: async () => undefined,
  };
  new Function("self", "caches", "fetch", src)(self, caches, async () => new Response("net"));
  const answer = (url: string, accept: string) => {
    let answered: Promise<Response> | undefined;
    handlers.fetch({
      request: new Request(url, { headers: { accept } }),
      respondWith: (p: Promise<Response>) => (answered = p),
      waitUntil: () => {},
    });
    return answered!;
  };
  return { answer, finishPut, puts };
}

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  return done;
};

describe("the service worker caches before it answers", () => {
  for (const [what, path, accept] of [
    ["a page", "/home", "text/html"],
    ["a build chunk (cache first)", "/_next/static/chunks/a.js", "*/*"],
    ["other /_next output (network first)", "/_next/image?url=x", "*/*"],
    ["anything else (network first)", "/icon.svg", "*/*"],
  ] as const) {
    test(what, async () => {
      const sw = await load();
      const res = sw.answer(`https://lianki.com${path}`, accept);
      expect(await settled(res)).toBe(false);
      expect(sw.puts).toEqual([`https://lianki.com${path}`]);
      sw.finishPut();
      expect(await (await res).text()).toBe("net");
    });
  }

  test("a cache write that fails still answers the page", async () => {
    const src = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
    const handlers: Record<string, Handler> = {};
    const self = {
      location: { hostname: "lianki.com", origin: "https://lianki.com" },
      addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
    };
    const caches = {
      open: async () => ({
        match: async () => undefined,
        put: async () => {
          throw new DOMException("full", "QuotaExceededError");
        },
      }),
      match: async () => undefined,
    };
    new Function("self", "caches", "fetch", src)(self, caches, async () => new Response("net"));
    let answered: Promise<Response> | undefined;
    handlers.fetch({
      request: new Request("https://lianki.com/home", { headers: { accept: "text/html" } }),
      respondWith: (p: Promise<Response>) => (answered = p),
    });
    expect(await (await answered!).text()).toBe("net");
  });
});
