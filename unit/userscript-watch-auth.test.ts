import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";

/**
 * Watch-time sync stands down when signed out.
 *
 * A signed-out tab retried `POST /api/fsrs/watch` every 30 s forever; every
 * retry was a request the Worker had to authenticate and refuse. A 401/403
 * now stops both flush loops for the page session, and the time stays dirty
 * on disk for the next page load to send.
 *
 * Runs against the BUILT public/lianki.user.js, lifting the real functions.
 */
const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

type Acc = Record<string, unknown>;
type Sync = {
  flushWatch: (acc: Acc) => Promise<void>;
  flushPendingWatch: (max?: number) => Promise<void>;
};

function lift(api: (path: string, opts?: unknown) => Promise<unknown>) {
  const start = BUILT.indexOf("let watchSyncUnavailable = false");
  const end = BUILT.indexOf("async function seedWatchFromServer(");
  if (start === -1 || end === -1) throw new Error("watch sync block not found in the build");
  const disk = new Map<string, { stats: unknown; dirty: boolean }>();
  const dirty = new Set<string>();
  const deps = {
    api,
    ORIGIN: "https://lianki.com",
    watchDeviceId: "dev1",
    WATCH_SAVE_MS: 5000,
    WATCH_MIN_SYNC_S: 60,
    mergeWatchStats: (_a: unknown, b: unknown) => b,
    encodeCoverage: () => "",
    pageTitle: () => "t",
    saveLocalWatch: (url: string, stats: unknown, d: boolean) => disk.set(url, { stats, dirty: d }),
    loadLocalWatch: (url: string) => disk.get(url) ?? { stats: null, dirty: false },
    watchDirtyAdd: (url: string) => dirty.add(url),
    watchDirtyDrop: (url: string) => dirty.delete(url),
    watchDirtyList: () => [...dirty],
    watchIndexTouch: () => {},
    logFail: () => {},
  };
  const names = Object.keys(deps);
  const sync = new Function(
    ...names,
    `${BUILT.slice(start, end)}; return { flushWatch, flushPendingWatch };`,
  )(...Object.values(deps)) as Sync;
  return { sync, disk, dirty };
}

const acc = (url: string): Acc => ({
  url,
  title: "t",
  dirty: true,
  wall: 120,
  media: 100,
  sessions: 1,
  days: {},
  cov: [],
  base: null,
});

const refusal = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("watch sync when signed out", () => {
  for (const status of [401, 403]) {
    it(`stops retrying after a ${status} and keeps the time queued`, async () => {
      let calls = 0;
      const { sync, disk, dirty } = lift(async () => {
        calls++;
        throw refusal(status);
      });
      const a = acc("https://example.com/v");
      await sync.flushWatch(a);
      expect(calls).toBe(1);
      // The next 30 s ticks send nothing — neither the live page nor the backlog.
      await sync.flushWatch(a);
      await sync.flushPendingWatch();
      expect(calls).toBe(1);
      // Nothing lost: still dirty in memory and on disk, for the next page load.
      expect(a.dirty).toBe(true);
      expect(disk.get("https://example.com/v")?.dirty).toBe(true);
      expect(dirty.has("https://example.com/v")).toBe(true);
    });
  }

  it("stops the backlog drain on a 401 as well", async () => {
    let calls = 0;
    const { sync, disk, dirty } = lift(async () => {
      calls++;
      throw refusal(401);
    });
    for (const u of ["https://a.test/1", "https://a.test/2"]) {
      disk.set(u, { stats: {}, dirty: true });
      dirty.add(u);
    }
    await sync.flushPendingWatch();
    await sync.flushPendingWatch();
    await sync.flushWatch(acc("https://a.test/3"));
    expect(calls).toBe(1);
    // The backlog stays queued; the live page persists through its own save path.
    expect([...dirty].sort()).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("keeps retrying a plain network failure", async () => {
    let calls = 0;
    const { sync } = lift(async () => {
      calls++;
      throw new Error("Network error");
    });
    const a = acc("https://example.com/v");
    await sync.flushWatch(a);
    await sync.flushWatch(a);
    expect(calls).toBe(2);
  });

  it("syncs normally when signed in", async () => {
    const { sync, dirty } = lift(async () => ({ ok: true }));
    const a = acc("https://example.com/v");
    await sync.flushWatch(a);
    expect(a.dirty).toBe(false);
    expect(dirty.size).toBe(0);
  });
});
