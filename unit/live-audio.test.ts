import { afterEach, expect, test } from "bun:test";
import {
  decodeLivePcm,
  liveAliases,
  encodeLivePcm,
  liveTicket,
  mixLiveFrame,
  type LivePcmFormat,
  type LiveTicket,
} from "../packages/debug-chat/src/live-audio-core";
import {
  connectLiveAudio,
  type LiveConnection,
  type LiveSocket,
} from "../packages/debug-chat/src/live-audio-client";
const mono: LivePcmFormat = { sampleRate: 16000, channels: 1, format: "s16le" };
const stereo: LivePcmFormat = { sampleRate: 48000, channels: 2, format: "s16le" };
const origin = "https://fixture.invalid";
const ticket = (): LiveTicket => ({
  version: 1,
  url: "ws://127.0.0.1:23456/stream",
  capability: "fixture-capability-not-a-real-secret",
  clientOrigin: origin,
  expiresAt: Date.now() + 30000,
  sourceId: "li-source",
  destinationId: "remote",
  input: mono,
  output: mono,
  frameMs: 20,
  maxFrameBytes: 640,
  inputWindowBytes: 5120,
});
const samples = (v: number, format = mono) =>
  new Float32Array((format.sampleRate / 50) * format.channels).fill(v);
const routes = [
  { sourceId: "source-a", destinationId: "remote", gain: 1 },
  { sourceId: "alias", destinationId: "remote", gain: 1 },
];

test("ticket is same-machine, origin-bound, unexpired and exactly framed", () => {
  expect(liveTicket(ticket(), origin).clientOrigin).toBe(origin);
  for (const patch of [
    { url: "wss://external.invalid/stream" },
    { url: "ws://localhost:23456/stream" },
    { url: "ws://127.0.0.1:23456/stream?capability=fixture" },
    { url: "ws://127.0.0.1:23456/stream#fragment" },
    { clientOrigin: "https://another.invalid" },
    { expiresAt: 0 },
    { maxFrameBytes: 638 },
    { inputWindowBytes: 640 },
    { destinationId: "li-source" },
    { input: { ...mono, sampleRate: 44100 } },
    { capability: "bad\nvalue" },
    { output: stereo },
    { version: 2 },
    { frameMs: 10 },
  ])
    expect(() => liveTicket({ ...ticket(), ...patch }, origin)).toThrow();
  expect(() => liveTicket(ticket(), "http://public.invalid")).toThrow();
});

test("mix-minus excludes original participant even under an alias; destinations mix independently", () => {
  const input = [
    { id: "source-a", origin: "local", format: mono, samples: samples(0.25) },
    { id: "alias", origin: "remote", format: mono, samples: samples(0.8) },
  ];
  const result = mixLiveFrame("remote", mono, routes, input, 2);
  expect(result.contributors).toEqual(["source-a"]);
  expect(result.samples.every((x) => x === 0.25)).toBe(true);
  expect(mixLiveFrame("another", mono, routes, input, 2).samples.every((x) => x === 0)).toBe(true);
  expect(() =>
    mixLiveFrame(
      "remote",
      mono,
      [{ sourceId: "remote", destinationId: "remote", gain: 1 }],
      input,
      2,
    ),
  ).toThrow();
});

test("basic 16/48k rate conversion and mono/stereo conversion occur before destination mixing", () => {
  const up = mixLiveFrame(
    "remote",
    stereo,
    routes,
    [{ id: "source-a", origin: "local", format: mono, samples: samples(0.25) }],
    2,
  );
  expect(up.samples.length).toBe(1920);
  expect(up.samples.every((x) => x === 0.25)).toBe(true);
  const ramp = new Float32Array(1920);
  for (let i = 0; i < 960; i++) {
    ramp[i * 2] = i / 960;
    ramp[i * 2 + 1] = -i / 960;
  }
  const down = mixLiveFrame(
    "remote",
    mono,
    routes,
    [{ id: "source-a", origin: "local", format: stereo, samples: ramp }],
    2,
  );
  expect(down.samples.length).toBe(320);
  expect(down.samples.every((x) => x === 0)).toBe(true);
  const stereoCopy = mixLiveFrame(
    "remote",
    stereo,
    routes,
    [{ id: "source-a", origin: "local", format: stereo, samples: ramp }],
    2,
  );
  expect(stereoCopy.samples).toEqual(ramp);
});

test("gain bounds and saturation prevent PCM wrap; removing one route preserves other input", () => {
  const input = [
    { id: "source-a", origin: "local", format: mono, samples: samples(0.8) },
    { id: "alias", origin: "another", format: mono, samples: samples(0.8) },
  ];
  const mixed = mixLiveFrame("remote", mono, routes, input, 2);
  expect(mixed.clipped).toBe(320);
  expect(mixed.samples.every((x) => x === 1)).toBe(true);
  expect(decodeLivePcm(encodeLivePcm(mixed.samples)).every((x) => x === 1)).toBe(true);
  expect(decodeLivePcm(encodeLivePcm(samples(-2))).every((x) => x === -1)).toBe(true);
  expect(mixLiveFrame("remote", mono, routes.slice(1), input, 2).contributors).toEqual(["alias"]);
  for (const gain of [-1, NaN, Infinity, 3])
    expect(() => mixLiveFrame("remote", mono, [{ ...routes[0], gain }], input, 2)).toThrow();
  expect(() =>
    mixLiveFrame("remote", mono, routes, [{ ...input[0], samples: new Float32Array(1) }], 2),
  ).toThrow();
  expect(() => encodeLivePcm(new Float32Array([NaN]))).toThrow();
  expect(() => decodeLivePcm(new ArrayBuffer(1))).toThrow();
});

const connections: LiveConnection[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.cancel();
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(consume: Parameters<typeof connectLiveAudio>[1]["consume"] = () => {}) {
  const t = ticket(),
    sent: (string | ArrayBuffer)[] = [];
  let timer: (() => void) | undefined;
  const ws: LiveSocket = {
    readyState: 0,
    bufferedAmount: 0,
    binaryType: "blob",
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      sent.push(data);
    },
    close() {
      ws.readyState = 3;
    },
  };
  const connection = connectLiveAudio(t, {
    socket: () => ws,
    consume,
    setTimer: (f) => {
      timer = f;
      return f;
    },
    clearTimer: () => {
      timer = undefined;
    },
  });
  connections.push(connection);
  const json = (data: unknown) => ws.onmessage?.({ data: JSON.stringify(data) });
  const ready = () => {
    ws.readyState = 1;
    ws.onopen?.();
    json({
      type: "ready",
      version: 1,
      sourceId: t.sourceId,
      destinationId: t.destinationId,
      input: mono,
      output: mono,
      frameMs: 20,
      maxFrameBytes: 640,
      inputWindowBytes: 5120,
      outputWindowBytes: 5120,
    });
  };
  const output = (sequence: number) => {
    json({
      type: "frame",
      sequence,
      sampleOffset: sequence * 320,
      byteLength: 640,
      sourceId: t.destinationId,
      destinationId: t.sourceId,
    });
    ws.onmessage?.({ data: encodeLivePcm(samples(0.25)) });
  };
  return { connection, ws, sent, json, ready, output, timeout: () => timer?.() };
}

test("output is consumed before input EOF and continues after half-close", async () => {
  const received: number[] = [];
  const f = fixture((frame) => {
    received.push(frame.sequence);
  });
  f.ready();
  await f.connection.ready;
  await f.connection.write(encodeLivePcm(samples(0.1)));
  f.output(0);
  await flush();
  expect(received).toEqual([0]);
  expect(f.connection.state()).toBe("ready");
  f.connection.endInput();
  f.json({ type: "input-ended" });
  f.output(1);
  await flush();
  expect(received).toEqual([0, 1]);
  expect(f.connection.state()).toBe("input-ended");
  expect(
    f.sent.filter((x) => typeof x === "string").map((x) => JSON.parse(x as string).type),
  ).toEqual(["hello", "output-ack", "end-input", "output-ack"]);
  await expect(f.connection.write(new ArrayBuffer(640))).rejects.toThrow();
});

test("credit is byte bounded, ACK ordering is validated and frame duration is exact", async () => {
  const f = fixture();
  f.ready();
  await f.connection.ready;
  await expect(f.connection.write(new ArrayBuffer(638))).rejects.toThrow();
  for (let i = 0; i < 8; i++) await f.connection.write(new ArrayBuffer(640));
  let ninthSent = false;
  const ninth = f.connection.write(new ArrayBuffer(640)).then(() => {
    ninthSent = true;
  });
  await flush();
  expect(ninthSent).toBe(false);
  f.json({ type: "credit", bytes: 640, inputSequence: 0 });
  await ninth;
  expect(ninthSent).toBe(true);
  f.json({ type: "credit", bytes: 640, inputSequence: 0 });
  expect(f.connection.state()).toBe("closed");
});

test("slow output cannot block route cancellation or another connection; late completion never ACKs", async () => {
  let release!: () => void, signal!: AbortSignal;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = fixture((_frame, s) => {
    signal = s;
    return blocked;
  });
  const fastFrames: number[] = [],
    fast = fixture((frame) => {
      fastFrames.push(frame.sequence);
    });
  slow.ready();
  fast.ready();
  await Promise.all([slow.connection.ready, fast.connection.ready]);
  slow.output(0);
  fast.output(0);
  await flush();
  slow.connection.cancel();
  expect(slow.connection.state()).toBe("closed");
  expect(signal.aborted).toBe(true);
  expect(fast.connection.state()).toBe("ready");
  expect(fastFrames).toEqual([0]);
  release();
  await flush();
  expect(slow.sent.some((x) => typeof x === "string" && JSON.parse(x).type === "output-ack")).toBe(
    false,
  );
  expect(slow.sent.some((x) => typeof x === "string" && JSON.parse(x).type === "cancel")).toBe(
    true,
  );
});

test("malformed frame metadata and excessive queued input fail closed", async () => {
  const bad = fixture();
  bad.ready();
  await bad.connection.ready;
  bad.json({
    type: "frame",
    sequence: 1,
    sampleOffset: 0,
    byteLength: 640,
    sourceId: "remote",
    destinationId: "li-source",
  });
  expect(bad.connection.state()).toBe("closed");
  const overflow = fixture();
  overflow.ready();
  await overflow.connection.ready;
  const writes = Array.from({ length: 17 }, () => overflow.connection.write(new ArrayBuffer(640)));
  const results = await Promise.allSettled(writes);
  expect(results.some((r) => r.status === "rejected")).toBe(true);
  expect(overflow.connection.state()).toBe("closed");
  const timeout = fixture();
  timeout.timeout();
  await expect(timeout.connection.ready).rejects.toThrow();
  expect(timeout.connection.state()).toBe("closed");
});

test("graceful close drains two received frames through a delayed sink; cancellation can still interrupt drain", async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const first = new Promise<void>((r) => {
      releaseFirst = r;
    }),
    second = new Promise<void>((r) => {
      releaseSecond = r;
    });
  const received: number[] = [];
  const f = fixture(async (frame) => {
    received.push(frame.sequence);
    await (frame.sequence === 0 ? first : second);
  });
  f.ready();
  await f.connection.ready;
  f.output(0);
  f.output(1);
  f.json({ type: "closed", reason: "duration-limit" });
  f.ws.onclose?.();
  expect(f.connection.state()).toBe("draining");
  expect(received).toEqual([0]);
  releaseFirst();
  await flush();
  expect(received).toEqual([0, 1]);
  expect(f.connection.state()).toBe("draining");
  releaseSecond();
  await flush();
  expect(f.connection.state()).toBe("closed");
  expect(f.sent.some((x) => typeof x === "string" && JSON.parse(x).type === "output-ack")).toBe(
    false,
  );

  let signal!: AbortSignal;
  const blocked = fixture((_frame, s) => {
    signal = s;
    return new Promise(() => {});
  });
  blocked.ready();
  await blocked.connection.ready;
  blocked.output(0);
  blocked.output(1);
  blocked.json({ type: "closed", reason: "renderer-ended" });
  expect(blocked.connection.state()).toBe("draining");
  blocked.connection.cancel();
  expect(blocked.connection.state()).toBe("closed");
  expect(signal.aborted).toBe(true);
});

test("graceful tail is bounded and transport failure never auto-reconnects", async () => {
  const stalled = fixture(() => new Promise(() => {}));
  stalled.ready();
  await stalled.connection.ready;
  stalled.output(0);
  stalled.json({ type: "closed", reason: "duration-limit" });
  stalled.timeout();
  expect(stalled.connection.state()).toBe("closed");
  const failed = fixture();
  failed.ready();
  await failed.connection.ready;
  failed.ws.onerror?.();
  expect(failed.connection.state()).toBe("closed");
  const bare: LiveSocket = {
    readyState: 0,
    bufferedAmount: 0,
    binaryType: "blob",
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
  };
  const defaults = connectLiveAudio(ticket(), { socket: () => bare, consume: () => {} });
  connections.push(defaults);
  defaults.cancel();
  await expect(defaults.ready).rejects.toThrow();
});

test("cancelling one unsent route frame does not stop another queued route or connection", async () => {
  const f = fixture();
  f.ready();
  await f.connection.ready;
  for (let i = 0; i < 8; i++) await f.connection.write(new ArrayBuffer(640));
  const routeA = new AbortController();
  const a = f.connection.write(new ArrayBuffer(640), routeA.signal).then(
    () => "sent",
    () => "cancelled",
  );
  let bSent = false;
  const b = f.connection.write(new ArrayBuffer(640)).then(() => {
    bSent = true;
  });
  routeA.abort();
  expect(await a).toBe("cancelled");
  expect(f.connection.state()).toBe("ready");
  expect(bSent).toBe(false);
  f.json({ type: "credit", bytes: 640, inputSequence: 0 });
  await b;
  expect(bSent).toBe(true);
  expect(f.connection.state()).toBe("ready");
});

test("internal source aliases cannot collide with valid participant identifiers", () => {
  const t = { ...ticket(), sourceId: "remote-return", destinationId: "synthetic-a" };
  const ids = liveAliases(t);
  expect(new Set([t.sourceId, t.destinationId, ...Object.values(ids)]).size).toBe(5);
  const mixed = mixLiveFrame(
    t.destinationId,
    mono,
    [{ sourceId: ids.a, destinationId: t.destinationId, gain: 1 }],
    [{ id: ids.a, origin: t.sourceId, format: mono, samples: samples(0.25) }],
    2,
  );
  expect(mixed.samples.every((x) => x === 0.25)).toBe(true);
});
