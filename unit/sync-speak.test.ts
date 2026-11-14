// Synchronized read-aloud (packages/debug-chat/src/sync-speak.ts): clock
// offsets from ping/pong samples, the wait before a stamped line, the ≥2
// devices gate, and two of his devices starting one line together. Fake
// synths and a fake clock: nothing here makes a sound.
import { describe, expect, it } from "bun:test";
import {
  CLOCK_KEEP,
  CLOCK_REFRESH_MS,
  CLOCK_ROUNDS,
  SYNC_LEAD_MS,
  SYNC_MAX_WAIT_MS,
  SYNC_SKEW_MS,
  clockPong,
  clockSample,
  createHubClock,
  estimateOffset,
  keepSamples,
  speakAtFor,
  syncDevices,
  syncWait,
  syncWanted,
} from "@lianki/debug-chat/sync-speak";
import { createVoice, type UtterLike } from "@lianki/debug-chat/voice";
import { CONFIG } from "@/lib/config";
import { FLAGS } from "@/lib/flags";

describe("clock offset", () => {
  it("one round: offset and round trip, NTP-style", () => {
    // Local clock 500 ms behind the hub; 40 ms each way; the hub answers at once.
    const t0 = 1_000;
    const t1 = t0 + 40 + 500;
    const s = clockSample(t0, t1, t1, t0 + 80);
    expect(s).toEqual({ offset: 500, rtt: 80, at: 1_080 });
  });

  it("an asymmetric path errs by at most half the round trip", () => {
    // 10 ms there, 90 ms back: the estimate is off by 40, under rtt/2 = 50.
    const s = clockSample(0, 10 + 200, 10 + 200, 100)!;
    expect(Math.abs(s.offset - 200)).toBeLessThanOrEqual(s.rtt / 2);
  });

  it("a nonsense round is no sample", () => {
    expect(clockSample(100, 50, 60, 90)).toBeNull(); // negative round trip
    expect(clockSample(0, 1, 1, 60_000)).toBeNull(); // far too slow to say anything
    expect(clockSample(0, Number.NaN, 1, 2)).toBeNull();
  });

  it("keeps the lowest-RTT samples and uses the best one", () => {
    const samples = [
      { offset: 900, rtt: 400, at: 1 },
      { offset: 510, rtt: 30, at: 2 },
      { offset: 480, rtt: 60, at: 3 },
      { offset: 700, rtt: 200, at: 4 },
      { offset: 505, rtt: 30, at: 5 },
      { offset: 600, rtt: 120, at: 6 },
    ];
    const kept = keepSamples(samples);
    expect(kept).toHaveLength(CLOCK_KEEP);
    expect(kept.map((s) => s.rtt)).toEqual([30, 30, 60, 120]);
    // Equal round trips: the newer one.
    expect(estimateOffset(samples)).toEqual({ offset: 505, rtt: 30, at: 5 });
    expect(estimateOffset([])).toBeNull();
  });

  it("the page's clock: a round of pings, one out at a time, then an offset", () => {
    let t = 10_000;
    const hubAhead = 250;
    const c = createHubClock(() => t);
    expect(c.offset()).toBeNull();
    expect(c.stale()).toBe(true);
    let pings = 0;
    let p = c.ping();
    while (p) {
      pings++;
      expect(c.ping()).toBeNull(); // still out
      t += 20;
      const pong = clockPong(JSON.stringify(p), t + hubAhead)!;
      t += 20;
      p = c.pong(pong) ? c.ping() : null;
    }
    expect(pings).toBe(CLOCK_ROUNDS);
    expect(c.offset()).toBe(hubAhead);
    expect(c.stale()).toBe(false);
    // A pong for another ping is ignored.
    expect(c.pong({ t0: 1, t1: 2, t2: 2 })).toBe(false);
    t += CLOCK_REFRESH_MS + 1;
    expect(c.stale()).toBe(true);
  });

  it("the hub answers only a clock ping", () => {
    expect(clockPong('{"type":"clock","t0":5}', 99)).toEqual({
      type: "clock",
      t0: 5,
      t1: 99,
      t2: 99,
    });
    expect(clockPong('{"type":"chat","t0":5}', 99)).toBeNull();
    expect(clockPong('{"type":"clock","t0":"x"}', 99)).toBeNull();
    expect(clockPong('{"type":"clock"', 99)).toBeNull();
    expect(clockPong({ type: "clock", t0: 5 }, 99)).toBeNull();
  });
});

describe("the wait", () => {
  it("waits until speakAt in its own clock, never more than the cap", () => {
    // Hub 100 ms ahead: speakAt 5_300 (hub) is 5_200 here.
    expect(syncWait({ speakAt: 5_300, offset: 100, now: 5_000 })).toBe(200);
    expect(syncWait({ speakAt: 50_000, offset: 0, now: 0 })).toBe(SYNC_MAX_WAIT_MS);
    expect(syncWait({ speakAt: 50_000, offset: 0, now: 0, maxWaitMs: 400 })).toBe(400);
  });

  it("already past it, no stamp, or no estimate: at once", () => {
    expect(syncWait({ speakAt: 5_000, offset: 0, now: 5_001 })).toBe(0);
    expect(syncWait({ speakAt: undefined, offset: 0, now: 0 })).toBe(0);
    expect(syncWait({ speakAt: "soon", offset: 0, now: 0 })).toBe(0);
    expect(syncWait({ speakAt: 5_000, offset: null, now: 0 })).toBe(0);
  });
});

describe("the ≥2 devices gate", () => {
  it("counts devices, not tabs", () => {
    expect(syncDevices([])).toBe(0);
    expect(
      syncDevices([
        { device: "mac", id: "a" },
        { device: "mac", id: "b" },
      ]),
    ).toBe(1);
    expect(
      syncDevices([
        { device: "mac", id: "a" },
        { device: "phone", id: "b" },
      ]),
    ).toBe(2);
    // A page whose device is not known yet counts alone.
    expect(syncDevices([{ device: "mac", id: "a" }, { id: "b" }])).toBe(2);
  });

  it("a single device never waits: no stamp", () => {
    expect(syncWanted(1)).toBe(false);
    expect(syncWanted(2)).toBe(true);
    expect(speakAtFor({ on: true, devices: 1, hubNow: 1_000 })).toBeUndefined();
    expect(speakAtFor({ on: false, devices: 3, hubNow: 1_000 })).toBeUndefined();
    expect(speakAtFor({ on: true, devices: 2, hubNow: 1_000 })).toBe(1_000 + SYNC_LEAD_MS);
    expect(speakAtFor({ on: true, devices: 2, hubNow: 1_000, leadMs: 500 })).toBe(1_500);
  });

  it("the flag and keys are registered with the defaults the code assumes", () => {
    const flag = (FLAGS as Record<string, { default: boolean; audience?: string }>)[
      "voice.sync-speak"
    ];
    expect(flag).toMatchObject({ default: true, audience: "owner" });
    expect(CONFIG["voice.syncLeadMs"].default).toBe(SYNC_LEAD_MS);
    expect(CONFIG["voice.syncMaxWaitMs"].default).toBe(SYNC_MAX_WAIT_MS);
    expect(CONFIG["voice.syncSkewMs"].default).toBe(SYNC_SKEW_MS);
  });
});

describe("two devices, one line", () => {
  /** One true clock with timers; each device sees it through its own skew. */
  function world() {
    let t = 1_000_000;
    const timers = new Set<{ f: () => void; at: number }>();
    return {
      now: () => t,
      setTimer: (f: () => void, ms: number) => {
        const x = { f, at: t + ms };
        timers.add(x);
        return x;
      },
      clearTimer: (x: unknown) => void timers.delete(x as { f: () => void; at: number }),
      advance(ms: number) {
        const end = t + ms;
        for (;;) {
          const due = [...timers].filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          timers.delete(due);
          t = Math.max(t, due.at);
          due.f();
        }
        t = end;
      },
    };
  }

  /** A device: its clock `skew` ms off the hub's, `up`/`down` ms to and from the hub. */
  function device(w: ReturnType<typeof world>, skew: number, up: number, down: number) {
    const local = () => w.now() + skew;
    const started: number[] = [];
    const v = createVoice({
      synth: () => ({
        speak: (u) => {
          started.push(w.now());
          w.setTimer(() => (u as UtterLike).onend?.(), 1_000);
        },
        cancel() {},
      }),
      utter: (text, lang) =>
        ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      now: local,
      setTimer: w.setTimer,
      clearTimer: w.clearTimer,
    });
    // Its clock estimate: rounds over a path that is a little jittery.
    const clock = createHubClock(local);
    for (const jitter of [30, 0, 12, 5]) {
      const p = clock.ping()!;
      const hubAt = w.now() + up + jitter; // the hub's clock is the true one
      const back = { ...clockPong(JSON.stringify(p), hubAt)! };
      const arrive = hubAt + down;
      // Pretend the round took that long (the fake world moves on).
      w.advance(arrive - w.now());
      clock.pong(back);
    }
    return { v, clock, local, started, down };
  }

  it("the faster device waits; both start within the tolerance", () => {
    const w = world();
    const fast = device(w, 140, 15, 15);
    const slow = device(w, -380, 120, 260);
    // The hub sends a line now, stamped for its two devices.
    const speakAt = speakAtFor({ on: true, devices: 2, hubNow: w.now() })!;
    const deliver = (d: typeof fast) =>
      w.setTimer(() => {
        const wait = syncWait({ speakAt, offset: d.clock.offset(), now: d.local() });
        d.v.reply("Une phrase.", { id: "l1" }, wait > 0 ? { startAt: d.local() + wait } : {});
      }, d.down);
    deliver(fast);
    deliver(slow);
    w.advance(5_000);
    expect(fast.started).toHaveLength(1);
    expect(slow.started).toHaveLength(1);
    expect(Math.abs(fast.started[0]! - slow.started[0]!)).toBeLessThanOrEqual(SYNC_SKEW_MS);
    // Without the stamp they would have started a whole delivery gap apart.
    expect(slow.down - fast.down).toBeGreaterThan(SYNC_SKEW_MS);
  });

  it("a device already past speakAt starts at once; a line without one never waits", () => {
    const w = world();
    const d = device(w, 0, 10, 10);
    const t0 = w.now();
    d.v.reply("Une phrase.", { id: "late" }, {});
    expect(d.started).toEqual([t0]);
    w.advance(2_000);
    // startAt in the past: no wait either.
    const t1 = w.now();
    d.v.reply("Une autre.", { id: "past" }, { startAt: d.local() - 50 });
    expect(d.started.at(-1)).toBe(t1);
  });

  it("the queue holds the stamped line until its time", () => {
    const w = world();
    const d = device(w, 0, 10, 10);
    const t0 = w.now();
    d.v.reply("Une phrase. Une autre.", { id: "l" }, { startAt: d.local() + 250 });
    expect(d.started).toEqual([]);
    w.advance(249);
    expect(d.started).toEqual([]);
    w.advance(1);
    expect(d.started).toEqual([t0 + 250]);
    // Only the line's first sentence waited: the next follows at once.
    w.advance(1_000);
    expect(d.started).toEqual([t0 + 250, t0 + 1_250]);
  });
});
