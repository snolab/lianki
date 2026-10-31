import { describe, expect, test } from "bun:test";
import { AudioCache, ttsUrl, type ClipDisk } from "@/lib/words/audio-cache";
import {
  AUDIO_CACHE_NAME,
  AudioDisk,
  pickEvictions,
  type CacheLike,
  type DiskIndex,
} from "@/lib/words/audio-disk";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A Cache API stand-in: a Map of URL → body text. */
function fakeCache() {
  const store = new Map<string, string>();
  const cache: CacheLike = {
    match: async (url) => (store.has(url) ? new Response(store.get(url)) : undefined),
    put: async (url, res) => void store.set(url, await res.text()),
    delete: async (url) => store.delete(url),
  };
  return { store, cache };
}

describe("pickEvictions", () => {
  const idx = (entries: [string, number, number][]): DiskIndex =>
    Object.fromEntries(entries.map(([u, size, used]) => [u, { size, used }]));

  test("nothing while under both caps", () => {
    expect(pickEvictions(idx([["a", 10, 1]]), 2, 100)).toEqual([]);
  });

  test("least recently used first, until the count fits", () => {
    const i = idx([
      ["new", 1, 30],
      ["old", 1, 10],
      ["mid", 1, 20],
    ]);
    expect(pickEvictions(i, 2, 100)).toEqual(["old"]);
    expect(pickEvictions(i, 1, 100)).toEqual(["old", "mid"]);
  });

  test("until the bytes fit", () => {
    const i = idx([
      ["a", 50, 1],
      ["b", 50, 2],
      ["c", 50, 3],
    ]);
    expect(pickEvictions(i, 10, 100)).toEqual(["a"]);
  });

  test("never a pinned clip — over the cap rather than a silent row on screen", () => {
    const i = idx([
      ["onScreen", 60, 1],
      ["b", 60, 2],
      ["c", 60, 3],
    ]);
    expect(pickEvictions(i, 10, 100, new Set(["onScreen"]))).toEqual(["b", "c"]);
    expect(pickEvictions(idx([["onScreen", 500, 1]]), 0, 0, new Set(["onScreen"]))).toEqual([]);
  });
});

test("the service worker keeps the clip cache when it updates", async () => {
  // public/sw.js deletes every other cache on activate.
  const sw = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const keep = sw.match(/const KEEP_CACHES = \[([^\]]*)\]/)?.[1] ?? "";
  expect(keep).toContain(JSON.stringify(AUDIO_CACHE_NAME));
});

describe("AudioDisk", () => {
  test("stores, finds, and evicts the least recently used past the cap", async () => {
    let now = 0;
    const { store, cache } = fakeCache();
    const disk = new AudioDisk({ open: async () => cache, now: () => ++now, maxEntries: 2 });
    await disk.put("/a", new Blob(["A"]));
    await disk.put("/b", new Blob(["B"]));
    // /a used again: /b is now the oldest.
    expect(await (await disk.get("/a"))!.text()).toBe("A");
    await disk.put("/c", new Blob(["C"]));
    expect(await disk.get("/b")).toBeNull();
    expect(store.has("/b")).toBe(false);
    expect(await disk.has("/a")).toBe(true);
    expect(await disk.has("/c")).toBe(true);
    expect(await disk.stats()).toEqual({ clips: 2, bytes: 2 });
  });

  test("a pinned clip outlives newer ones", async () => {
    let now = 0;
    const { cache } = fakeCache();
    const disk = new AudioDisk({ open: async () => cache, now: () => ++now, maxEntries: 1 });
    await disk.put("/onScreen", new Blob(["x"]));
    disk.pinned = new Set(["/onScreen"]);
    await disk.put("/b", new Blob(["y"]));
    expect(await disk.has("/onScreen")).toBe(true);
  });

  test("the index survives a reload, and a lost clip drops out of it", async () => {
    const { store, cache } = fakeCache();
    const first = new AudioDisk({ open: async () => cache });
    await first.put("/a", new Blob(["A"]));
    await first.put("/b", new Blob(["B"]));
    await first.flush();
    const second = new AudioDisk({ open: async () => cache });
    expect(await second.has("/a")).toBe(true);
    store.delete("/b");
    expect(await second.get("/b")).toBeNull();
    expect(await second.has("/b")).toBe(false);
  });

  test("a cache that cannot open is just a miss", async () => {
    const disk = new AudioDisk({ open: () => Promise.reject(new Error("no storage")) });
    expect(await disk.get("/a")).toBeNull();
    expect(await disk.has("/a")).toBe(false);
    await disk.put("/a", new Blob(["A"]));
  });
});

/** AudioCache over a fake disk and a network that answers at once. */
function withDisk(stored: Record<string, string> = {}, status = 200) {
  const fetched: string[] = [];
  const put: string[] = [];
  const disk: ClipDisk = {
    pinned: new Set(),
    get: async (url) => (url in stored ? new Blob([stored[url]]) : null),
    has: async (url) => url in stored,
    put: async (url, blob) => {
      put.push(url);
      stored[url] = await blob.text();
    },
  };
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const cache = new AudioCache({
    fetch: async (url) => {
      fetched.push(url);
      return new Response(status === 200 ? "mp3" : null, {
        status,
        headers: { "X-Voice": "recorded" },
      });
    },
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: () => {},
    disk,
    log: (e) => void events.push(e),
  });
  return { cache, disk, fetched, put, events };
}

describe("AudioCache with a disk", () => {
  test("memory → disk → network: a stored clip plays with no fetch", async () => {
    const { cache, fetched } = withDisk({ [ttsUrl("fr", "mot")]: "mp3" });
    expect(await cache.load("fr", "mot")).toEqual({ kind: "ok", url: "blob:1", from: "disk" });
    expect(fetched).toEqual([]);
    expect(await cache.load("fr", "mot")).toEqual({ kind: "ok", url: "blob:1", from: "memory" });
  });

  test("a fetched clip is stored; a miss or an error never is", async () => {
    const ok = withDisk();
    expect((await ok.cache.load("fr", "mot")) as unknown).toMatchObject({ from: "network" });
    await flush();
    expect(ok.put).toEqual([ttsUrl("fr", "mot")]);
    for (const status of [404, 400, 500, 429]) {
      const bad = withDisk({}, status);
      await bad.cache.load("fr", "mot");
      await flush();
      expect(bad.put).toEqual([]);
    }
  });

  test("a prefetch found on disk costs nothing toward the session cap", async () => {
    const { cache } = withDisk({ [ttsUrl("fr", "a")]: "x", [ttsUrl("fr", "b")]: "x" });
    cache.prefetch([
      { lang: "fr", text: "a" },
      { lang: "fr", text: "b" },
    ]);
    await flush();
    await flush();
    expect(cache.stats.started).toBe(0);
    expect(cache.peek("fr", "a")?.kind).toBe("ok");
  });

  test("stock: today's due words go to disk only, skipping what is there", async () => {
    const { cache, fetched, put } = withDisk({ [ttsUrl("fr", "have")]: "x" });
    cache.stock([
      { lang: "fr", text: "have" },
      { lang: "fr", text: "due" },
    ]);
    for (let i = 0; i < 4; i++) await flush();
    expect(fetched).toEqual([ttsUrl("fr", "due")]);
    expect(put).toEqual([ttsUrl("fr", "due")]);
    // Not kept in memory: the blob URLs are for the rows near the screen.
    expect(cache.stats.clips).toBe(0);
  });

  test("the rows on screen are pinned on disk", () => {
    const { cache, disk } = withDisk();
    cache.prefetch(
      [
        { lang: "fr", text: "seen" },
        { lang: "fr", text: "below" },
      ],
      { pinned: 1 },
    );
    expect([...disk.pinned]).toEqual([ttsUrl("fr", "seen")]);
  });
});

describe("AudioCache priorities", () => {
  /** A network that waits for the test to answer. */
  function slow() {
    const calls: { url: string; signal: AbortSignal; answer: () => void }[] = [];
    const disk: ClipDisk = {
      pinned: new Set(),
      get: async () => null,
      has: async () => false,
      put: async () => {},
    };
    let n = 0;
    const cache = new AudioCache({
      fetch: (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          calls.push({ url, signal, answer: () => resolve(new Response("mp3")) });
        }),
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: () => {},
      disk,
      maxConcurrent: 2,
      maxClips: 1,
    });
    const live = () => calls.filter((c) => !c.signal.aborted).map((c) => c.url);
    return { cache, calls, live };
  }
  const settle = async () => {
    for (let i = 0; i < 4; i++) await flush();
  };

  test("the visible rows take the due-word download's slots", async () => {
    const { cache, live } = slow();
    cache.stock([
      { lang: "fr", text: "due1" },
      { lang: "fr", text: "due2" },
    ]);
    await settle();
    expect(live()).toEqual([ttsUrl("fr", "due1"), ttsUrl("fr", "due2")]);
    cache.prefetch([{ lang: "fr", text: "seen" }], { pinned: 1 });
    await settle();
    expect(live()).toEqual([ttsUrl("fr", "due1"), ttsUrl("fr", "seen")]);
    // A tap takes the other.
    void cache.load("fr", "tap");
    await settle();
    expect(live()).toEqual([ttsUrl("fr", "seen"), ttsUrl("fr", "tap")]);
  });

  test("no due-word download while a prefetch is waiting", async () => {
    const { cache, live } = slow();
    cache.prefetch([
      { lang: "fr", text: "a" },
      { lang: "fr", text: "b" },
      { lang: "fr", text: "c" },
    ]);
    cache.stock([{ lang: "fr", text: "due" }]);
    await settle();
    expect(live()).toEqual([ttsUrl("fr", "a"), ttsUrl("fr", "b")]);
    expect(cache.stats.stocked).toBe(1);
  });

  test("a visible clip is never evicted from memory", async () => {
    const { cache, calls } = slow();
    cache.prefetch(
      [
        { lang: "fr", text: "seen" },
        { lang: "fr", text: "below" },
      ],
      { pinned: 1 },
    );
    await settle();
    calls[0].answer();
    await settle();
    calls[1].answer();
    await settle();
    // maxClips 1: "below" came last, but "seen" is on screen.
    expect(cache.peek("fr", "seen")?.kind).toBe("ok");
  });
});
