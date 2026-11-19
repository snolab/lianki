import { describe, expect, it } from "bun:test";
import {
  createMeetingTranscription,
  type MeetingTranscriptionOptions,
  type TranscriptionStatus,
} from "../lib/meeting-transcription/controller";
import { createMeetingChunkDecoder } from "../lib/meeting-transcription/decode";
import { createMeetingLocalStt } from "../lib/meeting-transcription/local-stt";
import { createBrowserMeetingTranscription } from "../lib/meeting-transcription/browser";
import type {
  MeetingLine,
  MeetingTranscriptSdk,
  PcmFrame,
} from "../lib/meeting-transcription/contracts";
import type { LocalFinal } from "@lianki/debug-chat/local-stt";
import type { WsLike } from "@lianki/debug-chat/local-stt";

const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
function setup() {
  const requests: { path: string; init?: RequestInit }[] = [],
    statuses: TranscriptionStatus[] = [];
  const drafts: (MeetingLine | null)[] = [],
    frames: PcmFrame[] = [];
  const callbacks: Parameters<MeetingTranscriptSdk["createLiveTranscriber"]>[0][] = [];
  let closes = 0;
  const sdk: MeetingTranscriptSdk = {
    createLiveTranscriber(options) {
      callbacks.push(options);
      return {
        async push(frame) {
          frames.push(frame);
        },
        async flush() {},
        close() {
          closes++;
        },
        bufferedSamples: () => 0,
      };
    },
    async *transcribeMeeting(input, options, signal) {
      for await (const frame of input) {
        if (signal?.aborted) throw new Error("aborted");
        const spans = await options.transcribe(frame, signal!);
        const lines = spans.map((span) => ({
          id: `${frame.track}:${frame.startSample / 16 + span.startMs}`,
          track: frame.track,
          startMs: frame.startSample / 16 + span.startMs,
          endMs: frame.startSample / 16 + span.endMs,
          speaker: frame.track === "me" ? "me" : "unknown",
          text: span.text,
        }));
        await options.onWindow?.({
          track: frame.track,
          startMs: frame.startSample / 16,
          endMs: (frame.startSample + frame.samples.length) / 16,
          lines,
        });
        for (const line of lines) yield line;
      }
    },
  };
  const limits = {
    maxFrameSamples: 16_000,
    maxQueuedSamplesPerTrack: 32_000,
    maxPendingLines: 4,
    maxRowsPerWrite: 4,
    maxLineChars: 1000,
    maxChunkBytes: 1024,
    maxChunkMs: 2000,
    maxMetadataBytes: 4096,
    maxChunksPerTrack: 20,
    maxDecodeDriftMs: 10,
  };
  const options: MeetingTranscriptionOptions = {
    meetingId: "meeting-test",
    sdk,
    limits,
    transcribe: async (window) => [
      { startMs: 0, endMs: window.samples.length / 16, text: "words" },
    ],
    fetch: (async (path: string | URL | Request, init?: RequestInit) => {
      requests.push({ path: String(path), init });
      if (String(path).endsWith("chunks?track=me"))
        return Response.json({
          chunks: [
            { track: "me", seq: 0, startMs: 1000, durMs: 1000 },
            { track: "me", seq: 2, startMs: 4000, durMs: 500 },
          ],
        });
      if (String(path).endsWith("chunks?track=others")) return Response.json({ chunks: [] });
      if (/chunks\/me\/\d+$/.test(String(path)))
        return new Response(new Uint8Array([1, 2]), {
          headers: {
            "x-lk-start-ms": String(path).endsWith("/0") ? "1000" : "4000",
            "x-lk-dur-ms": String(path).endsWith("/0") ? "1000" : "500",
          },
        });
      return Response.json({ ok: true });
    }) as typeof fetch,
    decodeChunk: async (_bytes, chunk) => new Float32Array(chunk.durMs * 16),
    onDraft(line) {
      drafts.push(line);
    },
    onStatus(status) {
      statuses.push(status);
    },
  };
  const puts = () =>
    requests.filter((r) => r.init?.method === "PUT").map((r) => JSON.parse(String(r.init!.body)));
  return {
    options,
    requests,
    statuses,
    drafts,
    frames,
    callbacks,
    puts,
    get closes() {
      return closes;
    },
  };
}
const frame = (track: "me" | "others" = "me", startSample = 0): PcmFrame => ({
  track,
  startSample,
  samples: new Float32Array(16_000).fill(0.5),
});
const line = (text = "words"): MeetingLine => ({
  id: "me:0",
  track: "me",
  startMs: 0,
  endMs: 1000,
  speaker: "me",
  text,
});

describe("concrete pinned SDK browser integration", () => {
  it("uses the actual live SDK with the recorder's offset callback only after choice", async () => {
    const h = setup();
    let calls = 0,
      detached = 0;
    let listener:
      | ((value: { track: "me" | "others"; offset: number; samples: Float32Array }) => void)
      | undefined;
    const recorder = {
      state: { meetingId: h.options.meetingId },
      onPcm(callback: NonNullable<typeof listener>) {
        listener = callback;
        return () => {
          detached++;
          listener = undefined;
        };
      },
    };
    const consumer = await createBrowserMeetingTranscription(
      { ...h.options, live: { windowMs: 1000, stepMs: 1000, overlapMs: 0 } },
      {
        getRecorder: () => {
          calls++;
          return recorder;
        },
      },
    );
    expect(calls).toBe(0);
    await consumer.startLive({ userInitiated: true });
    expect(calls).toBe(1);
    const capture = frame().samples;
    capture[0] = 1.0001;
    capture[1] = -1.0001;
    const raw = capture.slice(0, 2);
    listener!({ track: "me", offset: 0, samples: capture });
    await flush();
    await consumer.finishLive();
    expect(h.puts()).toEqual([
      {
        source: "live",
        lines: [{ track: "me", startMs: 0, endMs: 1000, speaker: "me", text: "words" }],
      },
    ]);
    expect(detached).toBe(1);
    expect(capture.slice(0, 2)).toEqual(raw);
    consumer.close();
  });

  it("does not mix a page singleton's next meeting into the previous transcript", async () => {
    const h = setup();
    let listener!: (value: {
      track: "me" | "others";
      offset: number;
      samples: Float32Array;
    }) => void;
    const recorder = {
      state: { meetingId: h.options.meetingId },
      onPcm(callback: typeof listener) {
        listener = callback;
        return () => {};
      },
    };
    const consumer = await createBrowserMeetingTranscription(
      { ...h.options, live: { windowMs: 1000, stepMs: 1000, overlapMs: 0 } },
      { getRecorder: () => recorder },
    );
    await consumer.startLive({ userInitiated: true });
    recorder.state.meetingId = "different-meeting";
    listener({ track: "me", offset: 0, samples: frame().samples });
    await flush();
    expect(h.puts()).toHaveLength(0);
    expect(h.statuses.at(-1)).toMatchObject({ phase: "stopped" });
    consumer.close();
  });

  it("uses actual offline window completion without touching the recorder", async () => {
    const h = setup();
    let calls = 0;
    const consumer = await createBrowserMeetingTranscription(h.options, {
      getRecorder: () => {
        calls++;
        throw new Error("Must not capture");
      },
    });
    await consumer.runFinal({ userInitiated: true });
    expect(calls).toBe(0);
    expect(h.puts()).toHaveLength(2);
    expect(h.puts().map((put) => put.replace)).toEqual([
      { track: "me", startMs: 1000, endMs: 2000 },
      { track: "me", startMs: 4000, endMs: 4500 },
    ]);
    consumer.close();
  });

  it("lazily loads the default recorder module without creating a capture singleton", async () => {
    const h = setup();
    const before = (globalThis as { __lkMeeting?: unknown }).__lkMeeting;
    const consumer = await createBrowserMeetingTranscription(h.options);
    expect((globalThis as { __lkMeeting?: unknown }).__lkMeeting).toBe(before);
    expect(h.requests).toHaveLength(0);
    consumer.close();
  });
});

describe("meeting transcription consumer", () => {
  it("does nothing until explicit per-meeting choice, and checks account access before creating a provider", async () => {
    const h = setup(),
      controller = createMeetingTranscription(h.options);
    expect(controller.push(frame())).toBe(false);
    expect(h.requests).toHaveLength(0);
    await expect(controller.startLive({ userInitiated: false } as never)).rejects.toMatchObject({
      code: "choice",
    });
    expect(h.callbacks).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    h.options.fetch = async () => new Response(null, { status: 404 });
    const refused = createMeetingTranscription(h.options);
    await expect(refused.startLive({ userInitiated: true })).rejects.toMatchObject({
      code: "server",
      status: 404,
    });
    expect(h.callbacks).toHaveLength(0);
    expect(h.puts()).toHaveLength(0);
    controller.close();
    refused.close();
  });

  it("keeps drafts in memory and uploads only stable rows with account credentials", async () => {
    const h = setup(),
      controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    controller.push(frame());
    await flush();
    h.callbacks[0].onDraft(line("draft"), "me");
    h.callbacks[0].onStatus?.({ kind: "draft-regressed", track: "me", startMs: 0, endMs: 1000 });
    expect(h.statuses.at(-1)).toMatchObject({
      code: "draft-regressed",
      range: { track: "me", startMs: 0, endMs: 1000 },
    });
    await flush();
    expect(h.puts()).toEqual([]);
    h.callbacks[0].onStable([line()]);
    await flush();
    const { id: _id, ...stored } = line();
    expect(h.puts()).toEqual([{ source: "live", lines: [stored] }]);
    const put = h.requests.find((r) => r.init?.method === "PUT")!;
    expect(put.path).toBe("/api/my/meetings/meeting-test/lines");
    expect(put.init?.credentials).toBe("same-origin");
    expect(put.init?.redirect).toBe("error");
    controller.close();
  });

  it("bounds each track independently, reports rejected ranges, and never mutates archival PCM", async () => {
    const h = setup(),
      blocked = deferred<void>();
    h.options.sdk.createLiveTranscriber = () => ({
      push: () => blocked.promise,
      async flush() {},
      close() {},
      bufferedSamples: () => 0,
    });
    const controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    const original = frame();
    expect(controller.push(original)).toBe(true);
    expect(controller.push(frame("me", 16_000))).toBe(true);
    expect(controller.push(frame("me", 32_000))).toBe(false);
    expect(controller.push(frame("others"))).toBe(true);
    expect(controller.bufferedSamples()).toBe(48_000);
    expect(h.statuses.some((s) => s.code === "queue" && s.gap?.startSample === 32_000)).toBe(true);
    controller.stop();
    expect(controller.bufferedSamples()).toBe(0);
    blocked.resolve();
    await flush();
    expect(original.samples[0]).toBe(0.5);
  });

  it("rejects backward timestamps instead of collapsing or replaying the timeline", async () => {
    const h = setup(),
      controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    controller.push(frame());
    expect(controller.push(frame("me", 8000))).toBe(false);
    expect(h.statuses.at(-1)).toMatchObject({ phase: "error", code: "timeline" });
    expect(controller.push(frame("me", 16_000))).toBe(false);
    controller.close();
  });

  it("clamps only admitted capture copies and keeps overshoot admission bounded", async () => {
    const h = setup(),
      blocked = deferred<void>();
    const admitted: PcmFrame[] = [];
    h.options.sdk.createLiveTranscriber = () => ({
      push(frame) {
        admitted.push(frame);
        return blocked.promise;
      },
      async flush() {},
      close() {},
      bufferedSamples: () => 0,
    });
    const controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    const source = frame();
    source.samples[0] = 1.0001;
    source.samples[1] = -1.0001;
    const raw = source.samples.slice(0, 2);
    expect(controller.push(source)).toBe(true);
    expect(admitted[0].samples[0]).toBe(1);
    expect(admitted[0].samples[1]).toBe(-1);
    expect(source.samples.slice(0, 2)).toEqual(raw);
    expect(controller.push(frame("me", 16_000))).toBe(true);
    const full = frame("me", 32_000);
    full.samples[0] = 2;
    let copies = 0;
    Object.defineProperty(full.samples, "slice", {
      value() {
        copies++;
        throw new Error("Queue rejected frames must not be copied");
      },
    });
    expect(controller.push(full)).toBe(false);
    expect(copies).toBe(0);
    expect(full.samples[0]).toBe(2);
    expect(controller.bufferedSamples()).toBe(32_000);
    controller.stop();
    blocked.resolve();
    await flush();
    expect(controller.bufferedSamples()).toBe(0);
  });

  it("rejects nonfinite or oversized capture before allocating a copy", async () => {
    for (const value of [NaN, Infinity, -Infinity, "oversize"] as const) {
      const h = setup(),
        controller = createMeetingTranscription(h.options);
      await controller.startLive({ userInitiated: true });
      const source = frame();
      source.samples = new Float32Array(
        value === "oversize" ? h.options.limits.maxFrameSamples + 1 : 1,
      );
      if (typeof value === "number") source.samples[0] = value;
      let copies = 0;
      Object.defineProperty(source.samples, "slice", {
        value() {
          copies++;
          throw new Error("Invalid frames must not be copied");
        },
      });
      expect(controller.push(source)).toBe(false);
      expect(copies).toBe(0);
      expect(controller.bufferedSamples()).toBe(0);
      expect(h.statuses.at(-1)).toMatchObject({ phase: "error", code: "audio" });
      controller.close();
    }
  });

  it("closes embedding resources when a live run stops", async () => {
    const h = setup();
    let closes = 0;
    h.options.embed = Object.assign(async () => null, {
      close() {
        closes++;
      },
    });
    const controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    controller.stop();
    expect(closes).toBe(1);
    controller.close();
    expect(closes).toBe(1);
  });

  it("forwards final window, silence and diarization settings and closes embedding after completion", async () => {
    const h = setup(),
      original = h.options.sdk.transcribeMeeting;
    let received: Parameters<MeetingTranscriptSdk["transcribeMeeting"]>[1] | undefined,
      closes = 0;
    h.options.final = {
      windowMs: 8000,
      overlapMs: 500,
      silenceRms: 0.004,
      diarization: {
        windowMs: 1200,
        hopMs: 600,
        similarityThreshold: 0.8,
        ambiguityMargin: 0.04,
        maxClusters: 4,
        silenceRms: 0.005,
      },
    };
    h.options.embed = Object.assign(async () => null, {
      close() {
        closes++;
      },
    });
    h.options.sdk.transcribeMeeting = (frames, options, signal) => {
      received = options;
      return original(frames, options, signal);
    };
    const controller = createMeetingTranscription(h.options);
    await controller.runFinal({ userInitiated: true });
    expect(received).toMatchObject(h.options.final);
    expect(received?.transcribe).toBe(h.options.transcribe);
    expect(received?.embed).toBe(h.options.embed);
    expect(closes).toBe(1);
    controller.close();
  });

  it("fences callbacks and a late push from a stopped generation", async () => {
    const h = setup(),
      controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    controller.push(frame());
    await flush();
    const old = h.callbacks[0];
    controller.stop();
    await controller.startLive({ userInitiated: true });
    controller.push(frame());
    await flush();
    old.onStable([line("stale")]);
    old.onDraft(line("stale"), "me");
    h.callbacks[1].onStable([line("new")]);
    await flush();
    expect(h.puts().flatMap((p) => p.lines.map((l: MeetingLine) => l.text))).toEqual(["new"]);
    expect(h.drafts.some((value) => value?.text === "stale")).toBe(false);
    controller.close();
  });

  it("stops live transcription visibly on server refusal without accepting further audio", async () => {
    const h = setup();
    const normal = h.options.fetch!;
    h.options.fetch = async (path, init) =>
      init?.method === "PUT" ? new Response(null, { status: 403 }) : normal(path, init);
    const controller = createMeetingTranscription(h.options);
    await controller.startLive({ userInitiated: true });
    controller.push(frame());
    await flush();
    h.callbacks[0].onStable([line()]);
    await flush();
    expect(h.statuses.at(-1)).toMatchObject({ phase: "error", code: "server", status: 403 });
    expect(controller.push(frame("me", 16_000))).toBe(false);
    expect(h.closes).toBe(1);
    controller.close();
  });

  it("fetches independent account chunks and atomically replaces final ranges including silence", async () => {
    const h = setup();
    let count = 0;
    h.options.transcribe = async (window) =>
      ++count === 1 ? [{ startMs: 0, endMs: window.samples.length / 16, text: "final words" }] : [];
    const controller = createMeetingTranscription(h.options);
    await controller.runFinal({ userInitiated: true });
    expect(h.puts()).toEqual([
      {
        source: "final",
        lines: [{ track: "me", startMs: 1000, endMs: 2000, speaker: "me", text: "final words" }],
        replace: { track: "me", startMs: 1000, endMs: 2000 },
      },
      { source: "final", lines: [], replace: { track: "me", startMs: 4000, endMs: 4500 } },
    ]);
    expect(h.requests.some((r) => r.path.endsWith("/chunks/me/2"))).toBe(true);
    expect(h.statuses.at(-1)).toEqual({ phase: "done" });
    controller.close();
  });

  it("aborts a pending decoder and never writes a stale result", async () => {
    const h = setup(),
      decoded = deferred<Float32Array>(),
      abort = new AbortController();
    let embeddingCloses = 0;
    h.options.embed = Object.assign(async () => null, {
      close() {
        embeddingCloses++;
      },
    });
    h.options.decodeChunk = () => decoded.promise;
    const controller = createMeetingTranscription(h.options),
      running = controller.runFinal({ userInitiated: true }, abort.signal);
    await flush();
    abort.abort();
    expect(embeddingCloses).toBe(1);
    decoded.resolve(new Float32Array(16_000));
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(h.puts()).toEqual([]);
    controller.close();
  });

  it("does not replace a failed window and strips raw provider errors", async () => {
    const h = setup();
    h.options.transcribe = async () => {
      throw new Error("private transcript and token");
    };
    const controller = createMeetingTranscription(h.options);
    await expect(controller.runFinal({ userInitiated: true })).rejects.toThrow(
      "Meeting transcription provider.",
    );
    expect(h.puts()).toEqual([]);
    expect(JSON.stringify(h.statuses)).not.toContain("private");
    controller.close();
  });

  it("rejects decoded audio with the wrong duration before inference or writes", async () => {
    const h = setup();
    h.options.decodeChunk = async () => new Float32Array(1);
    const controller = createMeetingTranscription(h.options);
    await expect(controller.runFinal({ userInitiated: true })).rejects.toMatchObject({
      code: "timeline",
    });
    expect(h.puts()).toEqual([]);
    controller.close();
  });

  it("subscribes to the recorder only after choice and detaches before flushing stable rows", async () => {
    const h = setup();
    let listener:
        | ((frame: { track: "me" | "others"; offset: number; samples: Float32Array }) => void)
        | undefined,
      detached = 0;
    h.options.subscribePcm = (callback) => {
      listener = callback;
      return () => {
        detached++;
        listener = undefined;
      };
    };
    h.options.sdk.createLiveTranscriber = (callbacks) => ({
      async push(frame) {
        h.frames.push(frame);
      },
      async flush() {
        callbacks.onStable([line()]);
        callbacks.onGap?.({ track: "me", startSample: 16_000, endSample: 32_000 });
      },
      close() {},
      bufferedSamples: () => 0,
    });
    const controller = createMeetingTranscription(h.options);
    expect(listener).toBeUndefined();
    await controller.startLive({ userInitiated: true });
    listener!({ ...frame(), offset: 0 });
    await flush();
    await controller.finishLive();
    expect(detached).toBe(1);
    expect(h.frames[0].startSample).toBe(0);
    expect(h.puts()).toHaveLength(1);
    expect(h.statuses.at(-1)).toEqual({ phase: "done" });
    controller.close();
  });

  it("aborts an authorization request before provider creation", async () => {
    const h = setup(),
      auth = deferred<Response>(),
      abort = new AbortController();
    let requestSignal: AbortSignal | undefined;
    h.options.fetch = async (_path, init) => {
      requestSignal = init?.signal as AbortSignal;
      return auth.promise;
    };
    const controller = createMeetingTranscription(h.options),
      running = controller.runFinal({ userInitiated: true }, abort.signal);
    await flush();
    abort.abort();
    expect(requestSignal?.aborted).toBe(true);
    auth.resolve(Response.json({ ok: true }));
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(h.callbacks).toHaveLength(0);
    controller.close();
  });

  it("cancels oversized audio response bodies before decoding", async () => {
    const h = setup(),
      normal = h.options.fetch!;
    let cancelled = 0,
      decoded = 0;
    h.options.fetch = async (path, init) =>
      path.endsWith("chunks/me/0")
        ? new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            {
              headers: { "content-length": "1025", "x-lk-start-ms": "1000", "x-lk-dur-ms": "1000" },
            },
          )
        : normal(path, init);
    h.options.decodeChunk = async () => {
      decoded++;
      return new Float32Array(16_000);
    };
    const controller = createMeetingTranscription(h.options);
    await expect(controller.runFinal({ userInitiated: true })).rejects.toMatchObject({
      code: "output",
    });
    expect(cancelled).toBe(1);
    expect(decoded).toBe(0);
    expect(h.puts()).toHaveLength(0);
    controller.close();
  });

  it("rejects chunk headers on a different timeline than the account index", async () => {
    const h = setup(),
      normal = h.options.fetch!;
    h.options.fetch = async (path, init) =>
      path.endsWith("chunks/me/0")
        ? new Response(new Uint8Array([1]), {
            headers: { "x-lk-start-ms": "999", "x-lk-dur-ms": "1000" },
          })
        : normal(path, init);
    const controller = createMeetingTranscription(h.options);
    await expect(controller.runFinal({ userInitiated: true })).rejects.toMatchObject({
      code: "timeline",
    });
    expect(h.puts()).toHaveLength(0);
    controller.close();
  });

  it("reports account network failures without leaking the underlying error", async () => {
    const h = setup();
    h.options.fetch = async () => {
      throw new Error("private request credential");
    };
    const controller = createMeetingTranscription(h.options);
    await expect(controller.startLive({ userInitiated: true })).rejects.toMatchObject({
      code: "server",
      message: "Meeting transcription server.",
    });
    expect(JSON.stringify(h.statuses)).not.toContain("credential");
    controller.close();
  });

  it("rejects a final batch outside the decoded timeline before making a write", async () => {
    const h = setup();
    h.options.sdk.transcribeMeeting = async function* (frames, options) {
      for await (const frame of frames) {
        await options.onWindow?.({ track: frame.track, startMs: 0, endMs: 9000, lines: [] });
        yield line();
      }
    };
    const controller = createMeetingTranscription(h.options);
    await expect(controller.runFinal({ userInitiated: true })).rejects.toMatchObject({
      code: "output",
    });
    expect(h.puts()).toHaveLength(0);
    controller.close();
  });
});

describe("independent audio chunk decoder", () => {
  it("rejects corrupt media and dishonest decoded duration with safe error codes", async () => {
    const broken = createMeetingChunkDecoder({
      maxChunkBytes: 100,
      maxChunkMs: 1000,
      maxDecodeDriftMs: 0,
      decodeAudioData: async () => {
        throw new Error("private media parser detail");
      },
    });
    await expect(
      broken(new ArrayBuffer(1), { seq: 0, startMs: 0, durMs: 1000 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "decode", message: "Meeting transcription decode." });
    const oversized = createMeetingChunkDecoder({
      maxChunkBytes: 100,
      maxChunkMs: 1000,
      maxDecodeDriftMs: 0,
      decodeAudioData: async () => ({
        length: 32_000,
        sampleRate: 16_000,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(32_000),
      }),
    });
    await expect(
      oversized(
        new ArrayBuffer(1),
        { seq: 0, startMs: 0, durMs: 1000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "timeline" });
  });
  it("mixes stereo and downsamples without playback or synthetic gap filling", async () => {
    const decoder = createMeetingChunkDecoder({
      maxChunkBytes: 100,
      maxChunkMs: 1000,
      maxDecodeDriftMs: 1,
      decodeAudioData: async () => ({
        length: 47_952,
        sampleRate: 48_000,
        numberOfChannels: 2,
        getChannelData: (n) => new Float32Array(47_952).fill(n ? 0.25 : 0.75),
      }),
    });
    const samples = await decoder(
      new ArrayBuffer(1),
      { seq: 0, startMs: 3000, durMs: 1000 },
      new AbortController().signal,
    );
    expect(samples.length).toBe(15_984);
    expect(samples[0]).toBeCloseTo(0.5);
  });
  it("rejects oversized chunks before decoding and ignores a decode completed after abort", async () => {
    let called = false;
    const decoded = deferred<{
      length: number;
      sampleRate: number;
      numberOfChannels: number;
      getChannelData(): Float32Array;
    }>();
    const decoder = createMeetingChunkDecoder({
      maxChunkBytes: 10,
      maxChunkMs: 1000,
      maxDecodeDriftMs: 0,
      decodeAudioData: () => {
        called = true;
        return decoded.promise;
      },
    });
    await expect(
      decoder(
        new ArrayBuffer(11),
        { seq: 0, startMs: 0, durMs: 1000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "audio" });
    expect(called).toBe(false);
    const abort = new AbortController(),
      running = decoder(new ArrayBuffer(1), { seq: 0, startMs: 0, durMs: 1000 }, abort.signal);
    abort.abort();
    decoded.resolve({
      length: 16_000,
      sampleRate: 16_000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(16_000),
    });
    await expect(running).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("existing Lianki STT adapter", () => {
  it("strips connection-factory exceptions before exposing them to the host", async () => {
    const transcribe = createMeetingLocalStt({
      route: "rtc:lianki",
      maxSamples: 32_000,
      createClient() {
        throw new Error("private connection token");
      },
    });
    await expect(transcribe(frame(), new AbortController().signal)).rejects.toMatchObject({
      code: "provider",
      message: "Meeting transcription provider.",
    });
    transcribe.close();
  });
  it("opens only the explicitly chosen rtc route and reuses a bounded client per track", async () => {
    let opened = 0,
      closed = 0,
      frames = 0;
    const routes: string[][] = [];
    const transcribe = createMeetingLocalStt({
      route: "rtc:lianki",
      maxSamples: 32_000,
      createClient(urls) {
        opened++;
        routes.push(urls);
        return {
          begin: (onPartial) => {
            onPartial("not a stable transcript");
            return {
              frame(samples) {
                frames += samples.length;
              },
              end: async () => ({ text: "words", lang: "en", ms: 3 }) as LocalFinal,
              cancel() {},
            };
          },
          close() {
            closed++;
          },
        };
      },
    });
    expect(opened).toBe(0);
    await expect(
      transcribe(frame("others", 160_000), new AbortController().signal),
    ).resolves.toEqual([{ startMs: 0, endMs: 1000, text: "words", lang: "en" }]);
    await transcribe(frame("others", 176_000), new AbortController().signal);
    await transcribe(frame("me"), new AbortController().signal);
    expect(routes).toEqual([["rtc:lianki"], ["rtc:lianki"]]);
    expect(frames).toBe(48_000);
    expect(closed).toBe(0);
    transcribe.close();
    expect(closed).toBe(2);
    expect(() => createMeetingLocalStt({ route: "wss:session", maxSamples: 32_000 })).toThrow();
  });
  it("rotates an idle client between windows before a short speech-session lease expires", async () => {
    let now = 0,
      opened = 0,
      closed = 0;
    const transcribe = createMeetingLocalStt({
      route: "rtc:lianki",
      maxSamples: 32000,
      connectionReuseMs: 30000,
      now: () => now,
      createClient: () => {
        opened++;
        return {
          begin: () => ({
            frame: () => {},
            end: async () => ({ text: "words" }) as LocalFinal,
            cancel: () => {},
          }),
          close: () => {
            closed++;
          },
        };
      },
    });
    await transcribe(frame(), new AbortController().signal);
    now = 29999;
    await transcribe(frame(), new AbortController().signal);
    expect(opened).toBe(1);
    now = 30000;
    await transcribe(frame(), new AbortController().signal);
    expect(opened).toBe(2);
    expect(closed).toBe(1);
    transcribe.close();
    expect(closed).toBe(2);
    expect(() =>
      createMeetingLocalStt({ route: "rtc:lianki", maxSamples: 32000, connectionReuseMs: 60000 }),
    ).toThrow();
  });
  it("closes on abort without falling back to another provider", async () => {
    const answer = deferred<LocalFinal>();
    let closes = 0;
    const transcribe = createMeetingLocalStt({
      route: "rtc:lianki",
      maxSamples: 32_000,
      createClient: () => ({
        begin: () => ({ frame() {}, end: () => answer.promise, cancel() {} }),
        close() {
          closes++;
        },
      }),
    });
    const abort = new AbortController(),
      running = transcribe(frame(), abort.signal);
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    expect(closes).toBeGreaterThan(0);
    answer.resolve({ text: "late" } as LocalFinal);
  });

  it("uses the real existing STT client with an explicitly approved fake socket", async () => {
    const sockets: WsLike[] = [];
    const sent: (string | Uint8Array)[] = [];
    const transcribe = createMeetingLocalStt({
      route: "ws://localhost:5193/lianki-stt",
      maxSamples: 32_000,
      openApprovedSocket() {
        const socket: WsLike = {
          readyState: 1,
          binaryType: "",
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send(value) {
            sent.push(value);
            if (typeof value === "string" && JSON.parse(value).t === "end")
              queueMicrotask(() =>
                socket.onmessage?.({
                  data: JSON.stringify({
                    t: "final",
                    id: JSON.parse(value).id,
                    text: "real client protocol",
                  }),
                }),
              );
          },
          close() {
            socket.readyState = 3;
            socket.onclose?.({});
          },
        };
        sockets.push(socket);
        return socket;
      },
    });
    const running = transcribe(frame(), new AbortController().signal);
    sockets[0].onmessage?.({ data: JSON.stringify({ t: "ready", model: "fake" }) });
    await expect(running).resolves.toMatchObject([
      { text: "real client protocol", startMs: 0, endMs: 1000 },
    ]);
    expect(sent.some((value) => value instanceof Uint8Array && value[0] === 1)).toBe(true);
    transcribe.close();
    expect(sockets[0].readyState).toBe(3);
  });

  it("rejects simultaneous utterances on one track while keeping the other track independent", async () => {
    const final = deferred<LocalFinal>();
    let connections = 0;
    const transcribe = createMeetingLocalStt({
      route: "rtc:lianki",
      maxSamples: 32_000,
      createClient: () => {
        connections++;
        return { begin: () => ({ frame() {}, end: () => final.promise, cancel() {} }), close() {} };
      },
    });
    const first = transcribe(frame("me"), new AbortController().signal);
    await expect(
      transcribe(frame("me", 16_000), new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
    const second = transcribe(frame("others"), new AbortController().signal);
    expect(connections).toBe(2);
    final.resolve({ text: "words" } as LocalFinal);
    await first;
    await second;
    transcribe.close();
  });
});
