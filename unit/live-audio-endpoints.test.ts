import { expect, test } from "bun:test";
import { createLiveMic, liveMic, liveMicFrames } from "../packages/debug-chat/src/live-mic";
import { audioOwner } from "../packages/debug-chat/src/audio-claim";
import { browserLiveMonitor, createLiveMonitor } from "../packages/debug-chat/src/live-monitor";
import { createMic, type VadEvents } from "../packages/debug-chat/src/mic";
import { encodeLivePcm } from "../packages/debug-chat/src/live-audio-core";

test("mic observer is explicit, isolated, copied and removable", () => {
  const bus = createLiveMic(),
    got: (Float32Array | null)[] = [];
  bus.publish(new Float32Array([1]));
  const bad = bus.subscribe(() => {
    throw Error("broken route");
  });
  const off = bus.subscribe((f) => got.push(f));
  const original = new Float32Array([0.5]);
  bus.publish(original);
  original[0] = 0;
  bus.publish(null);
  off();
  bad();
  bus.publish(original);
  expect(got.length).toBe(2);
  expect(got[0]?.[0]).toBe(0.5);
  expect(got[1]).toBeNull();
});
test("variable capture chunks reframe, expire, clear and bound real-time memory", () => {
  let now = 0;
  const q = liveMicFrames(() => now);
  q.push(new Float32Array(512).fill(0.5));
  expect(q.take()).toHaveLength(320);
  q.push(new Float32Array(128).fill(0.25));
  expect(q.take()[191]).toBe(0.5);
  expect(q.take()[0]).toBe(0);
  q.push(new Float32Array(320 * 30).fill(0.7));
  now = 161;
  expect(q.take()[0]).toBe(0);
  q.push(new Float32Array(319).fill(1));
  q.push(null);
  q.push(new Float32Array([1]));
  expect(q.take()[0]).toBe(0);
  q.clear();
  now = 1000;
  q.push(new Float32Array(319).fill(0.5));
  now = 2000;
  q.push(new Float32Array([0.25]));
  expect(q.take()[0]).toBe(0);
  q.push(new Float32Array(320 * 30).fill(NaN));
  expect(q.take()[0]).toBe(0);
});
test("actual mic hook excludes held and enrolment capture and ignores stale generations", async () => {
  let events!: VadEvents,
    enrol = false;
  const frames: (Float32Array | null)[] = [];
  const off = liveMic().subscribe((f) => frames.push(f));
  const mic = createMic({
    load: async (ev) => {
      events = ev;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => "",
    onState() {},
    onText() {},
    onPending() {},
    enrol: { active: () => enrol, begin: () => null } as never,
  });
  try {
    await mic.toggle();
    events.onFrame?.(new Float32Array([0.4]), 0.9);
    expect(frames.at(-1)?.[0]).toBeCloseTo(0.4);
    enrol = true;
    events.onFrame?.(new Float32Array([0.8]), 0.9);
    expect(frames.at(-1)).toBeNull();
    enrol = false;
    mic.hold(true);
    expect(frames.at(-1)).toBeNull();
    events.onFrame?.(new Float32Array([0.8]), 0.9);
    expect(frames.at(-1)).toBeNull();
    await mic.off();
    expect(frames.at(-1)).toBeNull();
    const n = frames.length;
    events.onFrame?.(new Float32Array([1]), 1);
    expect(frames.length).toBe(n);
  } finally {
    off();
    await mic.off();
  }
});
function monitorRig() {
  let allowed = true,
    holding = false,
    yieldNow = () => {},
    played = 0,
    stopped = 0;
  const jobs: { finish(): void }[] = [];
  const monitor = createLiveMonitor({
    allowed: () => allowed,
    owner(yielded) {
      yieldNow = yielded;
      return {
        claim: () => {
          holding = true;
          return true;
        },
        release() {
          holding = false;
        },
        dispose() {
          holding = false;
        },
        state: () => (holding ? "holding" : "idle"),
      };
    },
    play(samples) {
      expect(samples[0]).toBeCloseTo(0.5);
      played++;
      let finish!: () => void;
      const done = new Promise<void>((r) => {
        finish = r;
      });
      jobs.push({ finish });
      return {
        done,
        stop() {
          stopped++;
          finish();
        },
      };
    },
  });
  const signal = new AbortController();
  const play = () =>
    monitor.consume(
      encodeLivePcm(new Float32Array(320).fill(0.5)),
      { sampleRate: 16000, channels: 1, format: "s16le" },
      signal.signal,
    );
  return {
    monitor,
    play,
    signal,
    jobs,
    mute() {
      allowed = false;
      monitor.sync();
    },
    yieldNow: () => yieldNow(),
    counts: () => ({ played, stopped, holding }),
  };
}
test("monitor defaults silent; explicit enable, mute and disable stop current PCM", async () => {
  const r = monitorRig();
  await r.play();
  expect(r.counts().played).toBe(0);
  r.monitor.enable(true);
  const playing = r.play();
  expect(r.counts().played).toBe(1);
  r.mute();
  await playing;
  expect(r.counts()).toEqual({ played: 1, stopped: 1, holding: false });
  await r.play();
  expect(r.counts().played).toBe(1);
  r.monitor.dispose();
});
test("priority yield and cancellation drop PCM immediately, without stale replay", async () => {
  const r = monitorRig();
  r.monitor.enable(true);
  const first = r.play();
  r.yieldNow();
  await first;
  expect(r.counts().stopped).toBe(1);
  const second = r.play();
  r.signal.abort();
  await second;
  expect(r.counts()).toEqual({ played: 2, stopped: 2, holding: false });
  await r.play();
  expect(r.counts().played).toBe(2);
  r.monitor.dispose();
});

test("monitor setup/decode failures release priority and disposed monitors remain silent", async () => {
  let holding = false;
  const monitor = createLiveMonitor({
    allowed: () => true,
    owner: () => ({
      claim() {
        holding = true;
        return true;
      },
      release() {
        holding = false;
      },
      dispose() {
        holding = false;
      },
      state: () => (holding ? "holding" : "idle"),
    }),
    play() {
      throw Error("output refused");
    },
  });
  monitor.enable(true);
  const format = { sampleRate: 16000 as const, channels: 1 as const, format: "s16le" as const };
  await expect(
    monitor.consume(new ArrayBuffer(1), format, new AbortController().signal),
  ).rejects.toThrow();
  expect(holding).toBe(false);
  await expect(
    monitor.consume(
      encodeLivePcm(new Float32Array(320).fill(0.5)),
      format,
      new AbortController().signal,
    ),
  ).rejects.toThrow("output refused");
  expect(holding).toBe(false);
  monitor.dispose();
  await monitor.consume(
    encodeLivePcm(new Float32Array(320).fill(0.5)),
    format,
    new AbortController().signal,
  );
  expect(holding).toBe(false);
});

test("browser monitor refuses failed resume/closed context and stops on page hide", async () => {
  const target = new EventTarget(),
    page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let state = "running",
    readable = true,
    refuse = true,
    nodes = 0,
    stops = 0;
  const context = {
    get state() {
      return state;
    },
    resume: async () => {
      if (refuse) throw Error("resume refused");
    },
    createBuffer: () => ({ getChannelData: () => new Float32Array(320) }),
    createBufferSource: () => {
      nodes++;
      return {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          stops++;
        },
      };
    },
    destination: {},
  } as unknown as AudioContext;
  const format = { sampleRate: 16000 as const, channels: 1 as const, format: "s16le" as const };
  // This fixture owns its preference and event target regardless of full-suite order.
  const setup = () =>
    browserLiveMonitor({
      context: () => context,
      window: target,
      document: page,
      readAloud: () => readable,
    });
  let monitor = setup();
  try {
    await expect(
      monitor.consume(
        encodeLivePcm(new Float32Array(320).fill(0.5)),
        format,
        new AbortController().signal,
      ),
    ).rejects.toThrow("resume refused");
  } finally {
    monitor.dispose();
  }
  expect(nodes).toBe(0);
  refuse = false;
  state = "closed";
  monitor = setup();
  try {
    await expect(
      monitor.consume(
        encodeLivePcm(new Float32Array(320).fill(0.5)),
        format,
        new AbortController().signal,
      ),
    ).rejects.toThrow("audio-not-running");
  } finally {
    monitor.dispose();
  }
  expect(nodes).toBe(0);
  state = "running";
  monitor = setup();
  const higher = audioOwner({ target, id: "test-higher", prio: 99 });
  try {
    higher.claim();
    await monitor.consume(
      encodeLivePcm(new Float32Array(320).fill(0.5)),
      format,
      new AbortController().signal,
    );
    expect(nodes).toBe(0);
    higher.release();
    const playing = monitor.consume(
      encodeLivePcm(new Float32Array(320).fill(0.5)),
      format,
      new AbortController().signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(nodes).toBe(1);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    await playing;
    expect(stops).toBe(1);
    await monitor.consume(
      encodeLivePcm(new Float32Array(320).fill(0.5)),
      format,
      new AbortController().signal,
    );
    expect(nodes).toBe(1);
    page.visibilityState = "visible";
    readable = false;
    await monitor.consume(
      encodeLivePcm(new Float32Array(320).fill(0.5)),
      format,
      new AbortController().signal,
    );
    expect(nodes).toBe(1);
  } finally {
    higher.dispose();
    monitor.dispose();
  }
});

test("streamed silence never starts playback or holds a half-duplex microphone", async () => {
  const r = monitorRig();
  r.monitor.enable(true);
  await r.monitor.consume(
    new ArrayBuffer(640),
    { sampleRate: 16000, channels: 1, format: "s16le" },
    r.signal.signal,
  );
  expect(r.counts()).toEqual({ played: 0, stopped: 0, holding: false });
  r.monitor.dispose();
});

test("silent frames never interrupt another audio owner; positive and negative one-LSB frames still play", async () => {
  const target = new EventTarget();
  let yielded = 0,
    played = 0;
  const reader = audioOwner({
    target,
    id: "reader",
    prio: 1,
    onYield: () => {
      yielded++;
    },
  });
  const monitor = createLiveMonitor({
    allowed: () => true,
    owner: (onYield) => audioOwner({ target, id: "monitor", prio: 2, onYield }),
    play(samples) {
      expect(samples[0]).not.toBe(0);
      played++;
      return { done: Promise.resolve(), stop() {} };
    },
  });
  const format = { sampleRate: 16000 as const, channels: 1 as const, format: "s16le" as const };
  try {
    reader.claim();
    monitor.enable(true);
    await monitor.consume(new ArrayBuffer(640), format, new AbortController().signal);
    expect(yielded).toBe(0);
    expect(played).toBe(0);
    expect(reader.state()).toBe("holding");
    for (const sample of [1, -1]) {
      const frame = new ArrayBuffer(640);
      new DataView(frame).setInt16(0, sample, true);
      await monitor.consume(frame, format, new AbortController().signal);
    }
    expect(played).toBe(2);
    expect(yielded).toBe(2);
    expect(reader.state()).toBe("holding");
  } finally {
    monitor.dispose();
    reader.dispose();
  }
});
