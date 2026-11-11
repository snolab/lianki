/**
 * public/sw.js turns on navigation preload, so a cold launch's page request
 * leaves while the worker is still starting (docs/cold-start.md), and answers
 * a page from that early response. Off on a box, which answers nothing.
 */
import { describe, expect, test } from "bun:test";

type Handler = (e: Record<string, unknown>) => unknown;

async function load(hostname = "lianki.com", np: unknown = undefined) {
  const src = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const handlers: Record<string, Handler> = {};
  const fetched: string[] = [];
  const self = {
    location: { hostname, origin: `https://${hostname}` },
    registration: np === undefined ? undefined : { navigationPreload: np },
    addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({
      addAll: async () => {},
      put: async () => {},
      match: async () => undefined,
    }),
    match: async () => undefined,
  };
  const net = async (r: Request) => (fetched.push(r.url), new Response("net"));
  new Function("self", "caches", "fetch", src)(self, caches, net);
  const activate = async () => {
    const waits: Promise<unknown>[] = [];
    handlers.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  const page = (preloadResponse?: Promise<Response | undefined>) => {
    let answered: Promise<Response> | undefined;
    handlers.fetch({
      request: new Request("https://lianki.com/home", { headers: { accept: "text/html" } }),
      preloadResponse,
      respondWith: (p: Promise<Response>) => (answered = p),
      waitUntil: () => {},
    });
    return answered!;
  };
  return { activate, page, fetched };
}

const preloadSpy = () => {
  const calls: string[] = [];
  return {
    calls,
    enable: async () => void calls.push("enable"),
    disable: async () => void calls.push("disable"),
  };
};

describe("navigation preload", () => {
  test("is turned on when the worker activates", async () => {
    const np = preloadSpy();
    await (await load("lianki.com", np)).activate();
    expect(np.calls).toEqual(["enable"]);
  });

  test("is turned off on a box", async () => {
    const np = preloadSpy();
    await (await load("my-0123456789abcdef.lianki.com", np)).activate();
    expect(np.calls).toEqual(["disable"]);
  });

  test("a browser without it, or one that refuses, still activates", async () => {
    await (await load("lianki.com")).activate();
    const refusing = {
      enable: async () => {
        throw new Error("no");
      },
    };
    await (await load("lianki.com", refusing)).activate();
  });

  test("a page is answered from the early response, with no second request", async () => {
    const sw = await load();
    const res = await sw.page(Promise.resolve(new Response("early")));
    expect(await res.text()).toBe("early");
    expect(sw.fetched).toEqual([]);
  });

  test("no early response (or a failed one): the page is fetched as before", async () => {
    const early = [
      () => undefined,
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("x")),
    ];
    for (const pre of early) {
      const sw = await load();
      const res = await sw.page(pre());
      expect(await res.text()).toBe("net");
      expect(sw.fetched).toEqual(["https://lianki.com/home"]);
    }
  });
});
