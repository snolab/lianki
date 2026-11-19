import { describe, expect, it } from "bun:test";
import {
  AUDIO_SYNC_OFFSET_KEY,
  DEFAULT_LEAD_IN_MS,
  LATE_TOLERANCE_MS,
  type SyncPlayMessage,
  createAudioSyncPlay,
  readAudioSyncOffsetMs,
  writeAudioSyncOffsetMs,
} from "@lianki/debug-chat/audio-sync-play";
import {
  type AudioBufferLike,
  type BufferSourceLike,
  type CtxLike,
  type ElementLike,
  RESUME_REWIND_S,
  createCloudOut,
} from "@lianki/debug-chat/voice-out";

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeEl implements ElementLike {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  plays = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.currentTime = 0;
  }
}

function makeRig(opts: { decodeFails?: boolean; noBufferApi?: boolean; duration?: number } = {}) {
  const el = new FakeEl();
  const gainCalls: unknown[][] = [];
  const gain = {
    gain: {
      value: 1,
      cancelScheduledValues: (t: number) => void gainCalls.push(["cancel", t]),
      setValueAtTime: (v: number, t: number) => {
        gain.gain.value = v;
        gainCalls.push(["set", v, t]);
      },
      linearRampToValueAtTime: (v: number, t: number) => {
        gain.gain.value = v;
        gainCalls.push(["ramp", v, t]);
      },
    },
    connect: (n: unknown) => n,
  };

  const sources: {
    node: BufferSourceLike;
    connectedTo: unknown;
    started: { when?: number; offset?: number }[];
    stopped: number;
  }[] = [];

  let fetchCount = 0;
  let decodeCount = 0;

  const ctx: CtxLike = {
    currentTime: 10,
    destination: { kind: "dest" },
    state: "running",
    resume: () => Promise.resolve(),
    createGain: () => gain,
    createMediaElementSource: () => ({ connect: (n: unknown) => n }),
    ...(opts.noBufferApi
      ? {}
      : {
          decodeAudioData: async () => {
            decodeCount++;
            if (opts.decodeFails) throw new Error("decode failed");
            return { duration: opts.duration ?? 2.5 } satisfies AudioBufferLike;
          },
          createBufferSource: () => {
            const rec = {
              connectedTo: null as unknown,
              started: [] as { when?: number; offset?: number }[],
              stopped: 0,
              node: null as unknown as BufferSourceLike,
            };
            const node: BufferSourceLike = {
              buffer: null,
              playbackRate: { value: 1 },
              onended: null,
              connect: (n: unknown) => {
                rec.connectedTo = n;
                return n;
              },
              start: (when?: number, offset?: number) => {
                rec.started.push({ when, offset });
              },
              stop: () => {
                rec.stopped++;
              },
              disconnect: () => {},
            };
            rec.node = node;
            sources.push(rec);
            return node;
          },
        }),
  };

  let fakeNowMs = 1_000_000;
  const cloud = createCloudOut({
    fetch: async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(["wav-bytes"]),
      };
    },
    element: () => el,
    ctx: () => ctx,
    toUrl: () => "blob:test-1",
    revoke: () => {},
    now: () => fakeNowMs,
  });

  return {
    el,
    ctx,
    gain,
    gainCalls,
    sources,
    cloud,
    get fetchCount() {
      return fetchCount;
    },
    get decodeCount() {
      return decodeCount;
    },
    get nowMs() {
      return fakeNowMs;
    },
    setNowMs(v: number) {
      fakeNowMs = v;
    },
  };
}

describe("voice-out: scheduled Web Audio playback", () => {
  it("decodeClip + playScheduled routes AudioBufferSourceNode through the shared GainNode and supports ducking + stop", async () => {
    const rig = makeRig();
    rig.cloud.unlock();
    await tick();

    const decoded = await rig.cloud.decodeClip({ text: "Hello.", lang: "en" });
    expect(decoded.buffer.duration).toBe(2.5);
    expect(rig.fetchCount).toBe(1);
    expect(rig.decodeCount).toBe(1);

    // Second decodeClip for the same text uses cached decoded buffer.
    await rig.cloud.decodeClip({ text: "Hello.", lang: "en" });
    expect(rig.fetchCount).toBe(1);
    expect(rig.decodeCount).toBe(1);

    let ended = 0;
    const pb = rig.cloud.playScheduled(
      { buffer: decoded.buffer, when: 10.35, offset: 0.1, volume: 0.9, rate: 1.2 },
      { onend: () => ended++, onerror() {} },
    );

    expect(rig.sources.length).toBe(1);
    const src = rig.sources[0]!;
    expect(src.connectedTo).toBe(rig.gain);
    expect(src.node.playbackRate?.value).toBe(1.2);
    expect(src.started).toEqual([{ when: 10.35, offset: 0.1 }]);

    // Ducking ramps the shared GainNode.
    pb.volume(0.25, 80);
    expect(rig.gainCalls.some((c) => c[0] === "ramp" && c[1] === 0.25)).toBe(true);

    // Advance ctx.currentTime by 1.0s past start and stop -> rewound offset.
    rig.ctx.currentTime = 11.35;
    const stopped = pb.stop();
    expect(src.stopped).toBe(1);
    expect(stopped.at).toBeCloseTo(0.1 + 1.0 * 1.2 - RESUME_REWIND_S, 5);
    // Ended callback does not fire after stop.
    src.node.onended?.();
    expect(ended).toBe(0);
  });

  it("play({ sync: true, when }) falls back to <audio> element when decodeAudioData fails", async () => {
    const rig = makeRig({ decodeFails: true });
    let started = 0;
    rig.cloud.play(
      { text: "Fallback.", lang: "en", at: 0, volume: 0.8, sync: true, when: 10.2 },
      {
        onstart: () => started++,
        onend() {},
        onerror() {},
      },
    );
    await tick();
    await tick();
    rig.el.onloadedmetadata?.();
    await tick();
    expect(rig.sources.length).toBe(0);
    expect(rig.el.plays).toBe(1);
    expect(started).toBe(1);
  });
});

describe("audio-sync-play: hardware offset storage", () => {
  it("reads and writes lk:audio-sync-offset-ms safely", () => {
    const store: Record<string, string> = {};
    const mem = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    };
    expect(readAudioSyncOffsetMs(mem)).toBe(0);
    writeAudioSyncOffsetMs(85.4, mem);
    expect(store[AUDIO_SYNC_OFFSET_KEY]).toBe("85");
    expect(readAudioSyncOffsetMs(mem)).toBe(85);
    writeAudioSyncOffsetMs(-20, mem);
    expect(readAudioSyncOffsetMs(mem)).toBe(-20);
    writeAudioSyncOffsetMs(0, mem);
    expect(AUDIO_SYNC_OFFSET_KEY in store).toBe(false);
    expect(readAudioSyncOffsetMs({ getItem: () => "not-a-number" })).toBe(0);
    expect(
      readAudioSyncOffsetMs({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(0);
  });
});

describe("audio-sync-play: multi-device sync coordinator", () => {
  it("broadcasts { t: 'sync-play', clipKey, targetPeerMs } and schedules with peerOffsetMs + deviceOffsetMs", async () => {
    const rig = makeRig();
    const sent: SyncPlayMessage[] = [];
    const coord = createAudioSyncPlay({
      cloud: rig.cloud,
      ctx: () => rig.ctx,
      broadcast: (m) => sent.push(m),
      peerOffsetMs: () => 500, // peer clock = local + 500ms
      deviceOffsetMs: () => 40, // local speaker has +40ms hardware latency -> start 40ms earlier
      now: () => rig.nowMs,
    });

    const pb = coord.playSynced(
      { text: "Sync me.", lang: "en", at: 0, volume: 1 },
      { onend() {}, onerror() {} },
    );
    await tick();
    await tick();

    expect(sent.length).toBe(1);
    const msg = sent[0]!;
    expect(msg.t).toBe("sync-play");
    expect(msg.clipKey).toContain("Sync me.");
    expect(msg.targetPeerMs).toBe(rig.nowMs + 500 + DEFAULT_LEAD_IN_MS);

    // Local start = ctx.currentTime + (leadInMs - deviceOffsetMs) / 1000 = 10 + (350 - 40)/1000
    expect(rig.sources.length).toBe(1);
    expect(rig.sources[0]!.started[0]!.when).toBeCloseTo(10.31, 4);
    expect(rig.sources[0]!.started[0]!.offset).toBe(0);

    pb.stop();
    expect(rig.sources[0]!.stopped).toBe(1);
  });

  it("follower schedules at exact physical instant using its own peerOffsetMs and deviceOffsetMs", async () => {
    const rig = makeRig();
    rig.setNowMs(2_000_000);
    const coord = createAudioSyncPlay({
      cloud: rig.cloud,
      ctx: () => rig.ctx,
      broadcast: () => {},
      // Follower local clock is 100ms ahead of peer clock: peerMs = localMs - 100
      peerOffsetMs: () => -100,
      // Follower has 50ms Bluetooth latency
      deviceOffsetMs: () => 50,
      now: () => rig.nowMs,
    });

    const res = await coord.handleMessage({
      t: "sync-play",
      clipKey: "en\nluna\nHello.",
      targetPeerMs: 2_000_250, // targetLocal = 2_000_250 - (-100) = 2_000_350 -> rawDelay = 350ms -> effective = 300ms
      text: "Hello.",
      lang: "en",
      volume: 0.9,
      rate: 1,
    });

    expect(res.status).toBe("scheduled");
    if (res.status === "scheduled") {
      expect(res.delayMs).toBe(300);
      expect(res.seekSec).toBe(0);
      expect(res.when).toBeCloseTo(10.3, 4);
    }
    expect(rig.sources[0]!.started[0]!.when).toBeCloseTo(10.3, 4);
    expect(rig.sources[0]!.started[0]!.offset).toBe(0);
  });

  it("handles late arrival (<200ms) by starting immediately at exact buffer offset seekSec", async () => {
    const rig = makeRig({ duration: 3.0 });
    rig.setNowMs(5_000_120);
    const coord = createAudioSyncPlay({
      cloud: rig.cloud,
      ctx: () => rig.ctx,
      broadcast: () => {},
      peerOffsetMs: () => 0,
      deviceOffsetMs: () => 0,
      now: () => rig.nowMs,
    });

    // Target was 5_000_000, now is 5_000_120 -> 120ms late (< 200ms).
    const res = await coord.handleMessage({
      t: "sync-play",
      clipKey: "en\nluna\nLate.",
      targetPeerMs: 5_000_000,
      text: "Late.",
      lang: "en",
      rate: 1.5,
      at: 0.1,
    });

    expect(res.status).toBe("caught-up");
    if (res.status === "caught-up") {
      expect(res.lateMs).toBe(120);
      // seekSec = 0.1 + 0.120 * 1.5 = 0.28
      expect(res.seekSec).toBeCloseTo(0.28, 5);
      expect(res.when).toBe(10);
    }
    expect(rig.sources[0]!.started[0]!.when).toBe(10);
    expect(rig.sources[0]!.started[0]!.offset).toBeCloseTo(0.28, 5);
  });

  it("drops playback when targetTime already passed by >= LATE_TOLERANCE_MS (200ms)", async () => {
    const rig = makeRig();
    rig.setNowMs(5_000_250);
    const coord = createAudioSyncPlay({
      cloud: rig.cloud,
      ctx: () => rig.ctx,
      broadcast: () => {},
      now: () => rig.nowMs,
    });

    let failed = "";
    const res = await coord.handleMessage(
      {
        t: "sync-play",
        clipKey: "en\nluna\nTooLate.",
        targetPeerMs: 5_000_000,
        text: "TooLate.",
        lang: "en",
      },
      { onend() {}, onerror() {}, onfail: (r) => (failed = r) },
    );

    expect(res).toEqual({ status: "dropped", lateMs: 250 });
    expect(failed).toBe("sync-late");
    expect(rig.sources.length).toBe(0);
    expect(LATE_TOLERANCE_MS).toBe(200);
  });

  it("adapts lead-in buffer upward based on measured fetch+decode latency", async () => {
    let clock = 1_000;
    const rig = makeRig();
    const cloudWithSlowDecode = {
      ...rig.cloud,
      decodeClip: async (s: Parameters<typeof rig.cloud.decodeClip>[0]) => {
        clock += 500;
        const res = await rig.cloud.decodeClip(s);
        return { ...res, decodeMs: 500 };
      },
    };
    const sent: SyncPlayMessage[] = [];
    const coord = createAudioSyncPlay({
      cloud: cloudWithSlowDecode,
      ctx: () => rig.ctx,
      broadcast: (m) => sent.push(m),
      leadInMs: 350,
      adaptiveLeadIn: true,
      maxLeadInMs: 1_500,
      now: () => clock,
    });

    coord.playSynced({ text: "Slow.", lang: "en", at: 0, volume: 1 }, { onend() {}, onerror() {} });
    await tick();
    await tick();

    // ewma = 500 -> adapted = round(500 * 1.2 + 100) = 700ms > 350ms
    expect(coord.stats().leadInMs).toBe(700);
    expect(sent[0]!.targetPeerMs).toBe(clock + 700);
  });

  it("ignores duplicate sync-play messages and falls back to <audio> when Web Audio buffer API is absent", async () => {
    const rig = makeRig({ noBufferApi: true });
    const coord = createAudioSyncPlay({
      cloud: rig.cloud,
      ctx: () => rig.ctx,
      broadcast: () => {},
      now: () => rig.nowMs,
    });

    coord.playSynced(
      { text: "NoBuf.", lang: "en", at: 0, volume: 1 },
      { onend() {}, onerror() {} },
    );
    await tick();
    await tick();
    rig.el.onloadedmetadata?.();
    await tick();
    expect(rig.el.plays).toBe(1);

    const rig2 = makeRig();
    const coord2 = createAudioSyncPlay({
      cloud: rig2.cloud,
      ctx: () => rig2.ctx,
      broadcast: () => {},
      now: () => rig2.nowMs,
    });
    const msg: SyncPlayMessage = {
      t: "sync-play",
      clipKey: "en\nluna\nDup.",
      targetPeerMs: rig2.nowMs + 300,
      text: "Dup.",
      lang: "en",
    };
    const r1 = await coord2.handleMessage(msg);
    const r2 = await coord2.handleMessage(msg);
    expect(r1.status).toBe("scheduled");
    expect(r2).toEqual({ status: "ignored", reason: "duplicate" });
  });

  it("handles resolveClip, decode failures, wrong-type, and voice-out decode fallback", async () => {
    const rig = makeRig();
    const coord = createAudioSyncPlay({
      cloud: rig.cloud,
      ctx: () => rig.ctx,
      broadcast: () => {},
      now: () => rig.nowMs,
      resolveClip: (key) => {
        if (key === "buf") return Promise.resolve({ duration: 1.5 });
        if (key === "dec") return { text: "Resolved.", lang: "en" };
        return null;
      },
    });

    expect(await coord.handleMessage({ t: "other" } as never)).toEqual({
      status: "ignored",
      reason: "wrong-type",
    });

    const rBuf = await coord.handleMessage({
      t: "sync-play",
      clipKey: "buf",
      targetPeerMs: rig.nowMs + 200,
    });
    expect(rBuf.status).toBe("scheduled");
    const pb = coord.playSynced(
      { text: "Stop.", lang: "en", at: 0, volume: 1 },
      { onend() {}, onerror() {} },
    );
    pb.volume(0.4, 10);
    pb.stop();
    coord.stop();

    // Caught-up past buffer duration => ended
    let ended = false;
    const rEnd = await coord.handleMessage(
      {
        t: "sync-play",
        clipKey: "buf",
        targetPeerMs: rig.nowMs - 50,
        at: 1.48,
      },
      { onend: () => (ended = true), onerror() {} },
    );
    expect(rEnd.status).toBe("ended");
    expect(ended).toBe(true);

    const rDec = await coord.handleMessage({
      t: "sync-play",
      clipKey: "dec",
      targetPeerMs: rig.nowMs + 250,
    });
    expect(rDec.status).toBe("scheduled");

    let unknownWhy: string | undefined;
    const rUnk = await coord.handleMessage(
      { t: "sync-play", clipKey: "missing", targetPeerMs: rig.nowMs + 200 },
      { onend() {}, onerror() {}, onfail: (w) => (unknownWhy = w) },
    );
    expect(rUnk).toEqual({ status: "ignored", reason: "unknown-clip" });
    expect(unknownWhy).toBe("unknown clipKey");

    // Decode failure in handleMessage falls back to <audio>
    const failingRig = makeRig();
    failingRig.cloud.decodeClip = async () => {
      throw new Error("bad audio");
    };
    const coordFail = createAudioSyncPlay({
      cloud: failingRig.cloud,
      ctx: () => failingRig.ctx,
      broadcast: () => {},
      now: () => failingRig.nowMs,
    });
    const rFb = await coordFail.handleMessage({
      t: "sync-play",
      clipKey: "k-fail",
      targetPeerMs: failingRig.nowMs + 200,
      text: "Fallback.",
      lang: "en",
    });
    expect(rFb).toEqual({ status: "fallback" });

    // voice-out.ts sync=true falls back to <audio> when decodeAudioData rejects
    const origDecode = failingRig.ctx.decodeAudioData;
    failingRig.ctx.decodeAudioData = async () => {
      throw new Error("corrupt");
    };
    failingRig.cloud.play(
      { text: "Corrupt.", lang: "en", at: 0, volume: 1, sync: true },
      { onend() {}, onerror() {} },
    );
    await tick();
    await tick();
    failingRig.el.onloadedmetadata?.();
    await tick();
    expect(failingRig.el.plays).toBe(1);
    failingRig.ctx.decodeAudioData = origDecode;

    // fallbackPb stop + no AudioBufferSourceNode in handleMessage
    const noBufRig = makeRig({ noBufferApi: true });
    const coordNoBuf = createAudioSyncPlay({
      cloud: noBufRig.cloud,
      ctx: () => noBufRig.ctx,
      broadcast: () => {},
      now: () => noBufRig.nowMs,
      resolveClip: async () => ({ duration: 1 }),
    });
    const fbPb = coordNoBuf.playSynced(
      { text: "FbStop.", lang: "en", at: 0, volume: 1 },
      { onend() {}, onerror() {} },
    );
    fbPb.volume(0.5, 10);
    fbPb.stop();
    const rNoBuf = await coordNoBuf.handleMessage({
      t: "sync-play",
      clipKey: "k-nobuf",
      targetPeerMs: noBufRig.nowMs + 200,
    });
    expect(rNoBuf).toEqual({ status: "ignored", reason: "no AudioBufferSourceNode" });

    // playSynced falls back when decodeClip rejects
    const rejRig = makeRig();
    rejRig.cloud.decodeClip = async () => {
      throw new Error("decode err");
    };
    const coordRej = createAudioSyncPlay({
      cloud: rejRig.cloud,
      ctx: () => rejRig.ctx,
      broadcast: () => {},
      now: () => rejRig.nowMs,
      resolveClip: () => Promise.reject(new Error("resolve err")),
    });
    coordRej.playSynced(
      { text: "Rej.", lang: "en", at: 0, volume: 1 },
      { onend() {}, onerror() {} },
    );
    await tick();
    await tick();
    rejRig.el.onloadedmetadata?.();
    await tick();
    expect(rejRig.el.plays).toBe(1);

    let failMsg: string | undefined;
    const rResolveErr = await coordRej.handleMessage(
      { t: "sync-play", clipKey: "k-err", targetPeerMs: rejRig.nowMs + 200 },
      { onend() {}, onerror() {}, onfail: (w) => (failMsg = w) },
    );
    expect(rResolveErr).toEqual({ status: "ignored", reason: "decode-failed" });
    expect(failMsg).toBe("decode failed");

    // voice-out.ts sync=true succeeds via decodeClip + scheduleBuffer
    const okRig = makeRig();
    okRig.cloud.play(
      { text: "SyncOk.", lang: "en", at: 0, volume: 1, sync: true },
      { onend() {}, onerror() {} },
    );
    await tick();
    await tick();
    expect(okRig.sources.length).toBe(1);

    // Throwing storage & defaultStore / default deps do not throw
    expect(readAudioSyncOffsetMs()).toBe(0);
    writeAudioSyncOffsetMs(0);
    const defaultCoord = createAudioSyncPlay({
      cloud: okRig.cloud,
      ctx: () => okRig.ctx,
      broadcast: () => {},
    });
    expect(defaultCoord.stats().leadInMs).toBe(DEFAULT_LEAD_IN_MS);
    defaultCoord.playSynced(
      { text: "Def.", lang: "en", at: 0, volume: 1 },
      { onend() {}, onerror() {} },
    );
    await tick();
    await tick();
    expect(() =>
      writeAudioSyncOffsetMs(10, {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });
});
