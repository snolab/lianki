import { describe, expect, test } from "bun:test";
import { AudioCache, prefetchAllowed, ttsUrl, type AudioCacheDeps } from "@/lib/words/audio-cache";

/** A fake network: each fetch waits until the test answers it. */
function fakeNet() {
  type Call = {
    url: string;
    signal: AbortSignal;
    answer: (status?: number, headers?: Record<string, string>) => Promise<void>;
  };
  const calls: Call[] = [];
  const fetch: AudioCacheDeps["fetch"] = (url, { signal }) =>
    new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      calls.push({
        url,
        signal,
        answer: async (status = 200, headers = {}) => {
          resolve(new Response(status === 200 ? "mp3" : null, { status, headers }));
          await flush();
        },
      });
    });
  return { calls, fetch };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<AudioCacheDeps> = {}) {
  const net = fakeNet();
  const revoked: string[] = [];
  let n = 0;
  const cache = new AudioCache({
    fetch: net.fetch,
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: (u) => void revoked.push(u),
    // Three keeps the queue tests short; the default is checked on its own.
    maxConcurrent: 3,
    ...over,
  });
  return { cache, net, revoked };
}
const reqs = (n: number, lang = "fr") =>
  Array.from({ length: n }, (_, i) => ({ lang, text: `mot${i}` }));
const inFlight = <C extends { signal: AbortSignal }>(calls: C[]) =>
  calls.filter((c) => !c.signal.aborted);

describe("AudioCache prefetch", () => {
  test("no more than 3 fetches at once; the rest wait their turn", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(5));
    expect(net.calls.map((c) => c.url)).toEqual([0, 1, 2].map((i) => ttsUrl("fr", `mot${i}`)));
    await net.calls[0].answer();
    expect(net.calls).toHaveLength(4);
    expect(net.calls[3].url).toBe(ttsUrl("fr", "mot3"));
    expect(cache.stats.inFlight).toBe(3);
  });

  test("by default, six at once", () => {
    const net = fakeNet();
    const cache = new AudioCache({
      fetch: net.fetch,
      createObjectURL: () => "blob:x",
      revokeObjectURL: () => {},
    });
    cache.prefetch(reqs(10));
    expect(net.calls).toHaveLength(6);
  });

  test("stops at the session cap", async () => {
    const { cache, net } = setup({ maxSession: 4 });
    cache.prefetch(reqs(10));
    for (let k = 0; k < 4 && net.calls[k]; k++) await net.calls[k].answer();
    expect(net.calls).toHaveLength(4);
    cache.prefetch(reqs(10, "es"));
    expect(net.calls).toHaveLength(4);
    expect(cache.stats.started).toBe(4);
  });

  test("clips that cost nothing (recorded, already in R2) never use up the cap", async () => {
    const { cache, net } = setup({ maxSession: 2 });
    cache.prefetch(reqs(5));
    expect(net.calls).toHaveLength(2);
    // Given back: the queue goes on.
    await net.calls[0].answer(200, { "X-Voice": "recorded" });
    await net.calls[1].answer(200, { "X-Voice": "melotts-cached" });
    expect(net.calls).toHaveLength(4);
    await net.calls[2].answer(200, { "X-Voice": "melotts" });
    await net.calls[3].answer(200, { "X-Voice": "melotts" });
    // Two generated: the cap is reached, the fifth is never asked for.
    expect(net.calls).toHaveLength(4);
    expect(cache.stats.started).toBe(2);
  });

  test("rows scrolled past are given back to the cap", async () => {
    const { cache, net } = setup({ maxSession: 3 });
    cache.prefetch(reqs(3));
    cache.prefetch(reqs(3, "es"));
    await flush();
    expect(net.calls.slice(0, 3).every((c) => c.signal.aborted)).toBe(true);
    expect(inFlight(net.calls).map((c) => c.url)).toEqual(
      [0, 1, 2].map((i) => ttsUrl("es", `mot${i}`)),
    );
    expect(cache.stats.started).toBe(3);
  });

  test("Save-Data and 2G skip prefetching altogether", () => {
    for (const c of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      const { cache, net } = setup({ connection: () => c });
      cache.prefetch(reqs(3));
      expect(net.calls).toHaveLength(0);
    }
    expect(prefetchAllowed({ effectiveType: "4g" })).toBe(true);
    expect(prefetchAllowed(undefined)).toBe(true);
  });

  test("evicting from the LRU revokes the blob URL; a played clip is kept", async () => {
    const { cache, net, revoked } = setup({ maxClips: 2 });
    cache.prefetch(reqs(2));
    await net.calls[0].answer();
    await net.calls[1].answer();
    // mot0 is played: now the newest, so mot1 goes first.
    expect(cache.peek("fr", "mot0")).toEqual({ kind: "ok", url: "blob:1" });
    cache.prefetch([{ lang: "fr", text: "mot2" }]);
    await net.calls[2].answer();
    expect(revoked).toEqual(["blob:2"]);
    expect(cache.peek("fr", "mot1")).toBeUndefined();
    expect(cache.stats.clips).toBe(2);
  });

  test("a miss is remembered: never fetched again, and the tap is told at once", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(1));
    await net.calls[0].answer(404, { "X-Voice": "miss" });
    cache.prefetch(reqs(1));
    expect(await cache.load("fr", "mot0")).toEqual({ kind: "miss" });
    expect(net.calls).toHaveLength(1);
    // Other text in the language still gets fetched.
    cache.prefetch(reqs(2));
    expect(net.calls).toHaveLength(2);
  });

  test("a language with no server voice is dropped from the queue", async () => {
    const { cache, net } = setup();
    cache.prefetch([...reqs(4, "xx"), ...reqs(1, "fr")]);
    await net.calls[0].answer(404);
    expect(cache.isDead("xx")).toBe(true);
    expect(net.calls.map((c) => c.url)).toContain(ttsUrl("fr", "mot0"));
    expect(net.calls.filter((c) => c.url.includes("lang=xx"))).toHaveLength(3);
    expect(await cache.load("xx", "other")).toEqual({ kind: "dead" });
  });

  test("400 (too long to voice) is a miss too", async () => {
    const { cache, net } = setup();
    const p = cache.load("fr", "long");
    await net.calls[0].answer(400);
    expect(await p).toEqual({ kind: "miss" });
  });

  test("a 429 pauses prefetching; a failed prefetch is not retried by prefetch", async () => {
    let now = 1000;
    const { cache, net } = setup({ now: () => now });
    cache.prefetch(reqs(1));
    await net.calls[0].answer(429, { "Retry-After": "30" });
    cache.prefetch(reqs(2));
    expect(net.calls).toHaveLength(1);
    now += 31_000;
    cache.prefetch(reqs(2));
    expect(net.calls.map((c) => c.url)).toEqual([ttsUrl("fr", "mot0"), ttsUrl("fr", "mot1")]);
    // The tap still tries.
    void cache.load("fr", "mot0");
    expect(net.calls).toHaveLength(3);
  });

  test("rows that left are dropped from the queue and their fetches aborted", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(5));
    cache.prefetch(reqs(5).slice(3));
    await flush();
    expect(net.calls.slice(0, 3).every((c) => c.signal.aborted)).toBe(true);
    expect(inFlight(net.calls).map((c) => c.url)).toEqual(
      [3, 4].map((i) => ttsUrl("fr", `mot${i}`)),
    );
    expect(cache.stats.clips).toBe(0);
  });

  test("network errors fail quietly", async () => {
    const { cache } = setup({ fetch: () => Promise.reject(new TypeError("offline")) });
    expect(await cache.load("fr", "x")).toEqual({ kind: "fail" });
    expect(cache.stats.inFlight).toBe(0);
  });
});

describe("AudioCache tap priority", () => {
  test("the tapped clip starts at once, taking the newest prefetch's slot", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(6));
    const tap = cache.load("fr", "tapped");
    expect(net.calls).toHaveLength(4);
    expect(net.calls[3].url).toBe(ttsUrl("fr", "tapped"));
    // Still 3 at once: mot2 stepped back to the front of the queue.
    expect(net.calls[2].signal.aborted).toBe(true);
    expect(inFlight(net.calls)).toHaveLength(3);
    await net.calls[3].answer();
    expect(await tap).toEqual({ kind: "ok", url: "blob:1" });
    expect(net.calls[4].url).toBe(ttsUrl("fr", "mot2"));
  });

  test("a tap on a clip being prefetched waits for it, and saves it from abort", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(2));
    const tap = cache.load("fr", "mot1");
    cache.prefetch([]);
    await flush();
    expect(net.calls[0].signal.aborted).toBe(true);
    expect(net.calls[1].signal.aborted).toBe(false);
    await net.calls[1].answer();
    expect(await tap).toEqual({ kind: "ok", url: "blob:1" });
    expect(net.calls).toHaveLength(2);
  });

  test("a queued clip that is tapped leaves the queue and starts now", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(5));
    void cache.load("fr", "mot4");
    expect(net.calls.at(-1)!.url).toBe(ttsUrl("fr", "mot4"));
    expect(cache.stats.queued).toBe(2);
    // Taps don't count toward the session cap.
    expect(cache.stats.started).toBe(2);
  });

  test("warm: every part of the row at once, ahead of the prefetch", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(3));
    const parts = [
      { lang: "fr", text: "mot" },
      { lang: "en", text: "word" },
      { lang: "fr", text: "" },
      { lang: "fr", text: "Un mot." },
    ];
    cache.warm(parts);
    const wanted = parts.filter((p) => p.text).map((p) => ttsUrl(p.lang, p.text));
    expect(inFlight(net.calls).map((c) => c.url)).toEqual(wanted);
    for (const c of inFlight(net.calls)) await c.answer();
    expect(cache.peek("en", "word")?.kind).toBe("ok");
    // The prefetches it pushed aside start again, in their order.
    expect(net.calls.slice(6).map((c) => c.url)).toEqual(
      [0, 1, 2].map((i) => ttsUrl("fr", `mot${i}`)),
    );
  });

  test("a prefetched clip plays without a fetch", async () => {
    const { cache, net } = setup();
    cache.prefetch(reqs(1));
    await net.calls[0].answer();
    expect(await cache.load("fr", "mot0")).toEqual({ kind: "ok", url: "blob:1" });
    expect(net.calls).toHaveLength(1);
  });
});
