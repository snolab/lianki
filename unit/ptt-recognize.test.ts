import { describe, expect, test } from "bun:test";
import { createPttRecognition } from "../packages/debug-chat/src/ptt-recognize";
import type { LocalFinal, LocalStt } from "../packages/debug-chat/src/local-stt";

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const final = (text: string, extra: Partial<LocalFinal> = {}): LocalFinal => ({
  text,
  model: "sensevoice",
  ms: 2,
  endToFinalMs: 4,
  ...extra,
});
function fixture(
  options: {
    local?: boolean;
    segmentMs?: number;
    beginNull?: boolean;
    beginThrow?: boolean;
    frameThrow?: boolean;
    endThrow?: boolean;
    endReject?: boolean;
    final?: (i: number) => LocalFinal;
    request?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    cloud?: (audio: Float32Array, signal: AbortSignal) => Promise<{ text: string; model?: string }>;
    recheck?: boolean;
    maxMs?: number;
    timeout?: (ms: number) => AbortSignal;
  } = {},
) {
  let now = 1000;
  let state: "ready" | "down" = "ready";
  let closed = 0;
  let cancelled = 0;
  const parts: string[] = [];
  const failures: Error[] = [];
  const segments: {
    frames: Float32Array[];
    audio?: Float32Array;
    partial: (text: string) => void;
  }[] = [];
  const requests: Record<string, unknown>[] = [];
  const calls: { audio: Float32Array; signal: AbortSignal }[] = [];
  const local: LocalStt = {
    begin(partial) {
      if (options.beginThrow) throw Error("begin failed");
      if (options.beginNull) return null;
      const index = segments.length;
      const segment = {
        frames: [] as Float32Array[],
        audio: undefined as Float32Array | undefined,
        partial,
      };
      segments.push(segment);
      return {
        frame: (audio) => {
          if (options.frameThrow) throw Error("frame failed");
          segment.frames.push(audio.slice());
        },
        cancel: () => {
          cancelled++;
        },
        end(audio) {
          segment.audio = audio.slice();
          if (options.endThrow) throw Error("end failed");
          return options.endReject
            ? Promise.reject(Error("socket down"))
            : Promise.resolve(
                options.final?.(index) ??
                  final(`stream ${index + 1}`, { proof: `proof-${index + 1}` }),
              );
        },
      };
    },
    request: async (request) => {
      requests.push(request);
      return options.request
        ? options.request(request)
        : {
            ok: true,
            auto: true,
            run: "press-run",
            text: "whole local",
            engine: "mlx-whisper",
            lang: "en",
          };
    },
    close: () => {
      closed++;
    },
    state: () => state,
    connected: () => state === "ready",
    warm() {},
    keep() {},
    speaker: () => undefined,
    subscribe: () => () => {},
  };
  const rec = createPttRecognition({
    now: () => now,
    run: "press-run",
    rate: 1000,
    startAt: 1000,
    maxCaptureMs: options.maxMs ?? 60_000,
    localSegmentMs: options.segmentMs ?? 30_000,
    partialMinMs: 3000,
    partialEveryMs: 2500,
    requestTimeoutMs: 6000,
    timeout: options.timeout,
    ...(options.local ? { local } : {}),
    ...(options.recheck === false ? {} : { recheck: { maxSec: 60, timeoutMs: 20_000 } }),
    cloud: async (audio, signal) => {
      calls.push({ audio: audio.slice(), signal });
      return options.cloud
        ? options.cloud(audio, signal)
        : { text: "whole cloud", model: "@cf/openai/whisper-large-v3-turbo" };
    },
    onPartial: (text) => parts.push(text),
    onFailure: (error) => failures.push(error),
  });
  return {
    rec,
    parts,
    failures,
    segments,
    requests,
    calls,
    now: (value: number) => {
      now = value;
    },
    down: () => {
      state = "down";
    },
    closed: () => closed,
    cancelled: () => cancelled,
  };
}

describe("one PTT recognition transaction", () => {
  test("trims exact pointer bounds, keeps actual captured duration, and has no pre-roll/tail", async () => {
    const f = fixture();
    f.rec.frame(Float32Array.from([1, 2, 3]), 990); // entirely before down
    f.rec.frame(
      Float32Array.from({ length: 20 }, (_, i) => i),
      990,
    );
    f.rec.frame(
      Float32Array.from({ length: 20 }, (_, i) => 20 + i),
      1010,
    );
    f.now(1100);
    const result = await f.rec.finish(1025);
    expect([...f.calls[0]!.audio]).toEqual(Array.from({ length: 25 }, (_, i) => i + 10));
    expect(result.audioMs).toBe(25);
    expect(result.timing).toMatchObject({
      t_speechStart: 1000,
      t_speechEnd: 1025,
      audioMs: 25,
      t_sttDone: 1100,
    });
    expect(result.text).toBe("whole cloud");
    expect(result.recheck).toBeUndefined();
    await expect(f.rec.finish(1025)).rejects.toThrow("ptt-cancelled");
  });

  test("independent streaming final/proof stays baseline while existing exact-window recheck provides HQ", async () => {
    const f = fixture({ local: true });
    f.rec.frame(new Float32Array(100), 1000);
    f.segments[0]!.partial("live words");
    expect(f.parts).toEqual(["live words"]);
    f.now(1300);
    const result = await f.rec.finish(1100);
    expect(f.requests).toEqual([
      {
        t: "recheck",
        auto: true,
        engine: "mlx-whisper",
        run: "press-run",
        fromAgoMs: 300,
        toAgoMs: 200,
      },
    ]);
    expect(result).toMatchObject({
      text: "stream 1",
      stt: { route: "local", engine: "sensevoice" },
      speakerProof: ["proof-1"],
      recheck: {
        at: 1300,
        engine: "mlx-whisper",
        heard: "stream 1",
        text: "whole local",
        lang: "en",
      },
    });
    expect(f.calls).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("local segments retain completed prefix and use one recheck window for the entire press", async () => {
    const f = fixture({ local: true, segmentMs: 100 });
    f.rec.frame(new Float32Array(100), 1000);
    await tick();
    f.rec.frame(new Float32Array(50), 1100);
    f.segments[1]!.partial("second prefix");
    expect(f.parts.at(-1)).toBe("stream 1 second prefix");
    f.now(1200);
    const result = await f.rec.finish(1150);
    expect(result.text).toBe("stream 1 stream 2");
    expect(result.speakerProof).toEqual(["proof-1", "proof-2"]);
    expect(f.segments[0]!.audio).toHaveLength(100);
    expect(f.segments[1]!.audio).toHaveLength(50);
    expect(f.requests).toHaveLength(1);
  });

  test("cloud progressive preview is bounded and preserved as a partial reading while formal body stays complete", async () => {
    let finishPreview!: (out: { text: string; model: string }) => void;
    let requests = 0;
    const f = fixture({
      cloud: async () =>
        ++requests === 1
          ? new Promise((resolve) => {
              finishPreview = resolve;
            })
          : { text: "complete full ending", model: "cloud-whole" },
    });
    f.rec.frame(new Float32Array(3000), 1000);
    f.rec.frame(new Float32Array(3000), 4000);
    expect(f.calls).toHaveLength(1);
    finishPreview({ text: "shown prefix", model: "cloud-preview" });
    await tick();
    expect(f.parts).toEqual(["shown prefix"]);
    f.now(7100);
    const result = await f.rec.finish(7000);
    expect(result.text).toBe("complete full ending");
    expect(result.stt).toEqual({ route: "cloud", engine: "cloud-whole" });
    expect(result.recheck).toMatchObject({
      heard: "shown prefix",
      text: "complete full ending",
      engine: "cloud-whole",
      heardPartial: true,
    });
    expect(f.calls).toHaveLength(2);
  });

  test("late preview/cancel/account changes never publish partials or return a sendable result", async () => {
    let complete!: (out: { text: string }) => void;
    const f = fixture({
      cloud: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    f.rec.frame(new Float32Array(3000), 1000);
    f.rec.abort();
    expect(f.calls[0]!.signal.aborted).toBe(true);
    complete({ text: "late old account" });
    await tick();
    expect(f.parts).toEqual([]);
    f.rec.frame(new Float32Array(1), 4000);
    await expect(f.rec.finish(4000)).rejects.toThrow("ptt-cancelled");
  });

  test("cloud preview remains explicitly provisional at the same sample count as the final decode", async () => {
    let requests = 0;
    const f = fixture({
      cloud: async () => ({
        text: ++requests === 1 ? "shown preview" : "correct whole",
        model: "cloud-model",
      }),
    });
    f.rec.frame(new Float32Array(3000), 1000);
    await tick();
    expect(f.parts).toEqual(["shown preview"]);
    const out = await f.rec.finish(4000);
    expect(out.text).toBe("correct whole");
    expect(out.recheck).toMatchObject({
      heard: "shown preview",
      text: "correct whole",
      heardPartial: true,
    });
  });

  test("cap stops capture immediately with explicit error and no silent truncated send", async () => {
    const f = fixture({ local: true, maxMs: 100 });
    f.rec.frame(new Float32Array(100), 1000);
    f.rec.frame(new Float32Array(1), 1100);
    expect(f.failures.map((error) => error.message)).toEqual(["ptt-too-long"]);
    expect(f.cancelled()).toBe(1);
    expect(f.closed()).toBe(1);
    f.rec.frame(new Float32Array(100), 1101);
    await expect(f.rec.finish(1201)).rejects.toThrow("ptt-too-long");
    expect(f.calls).toEqual([]);
  });

  test("a late segment final after cap cannot overwrite the retained failure partial", async () => {
    const f = fixture({ local: true, segmentMs: 100, maxMs: 100 });
    f.rec.frame(new Float32Array(100), 1000);
    // The first segment's resolved final is still queued as a promise callback.
    f.rec.frame(new Float32Array(1), 1100);
    expect(f.failures).toHaveLength(1);
    await tick();
    f.segments[0]!.partial("late partial");
    expect(f.parts).toEqual([]);
    await expect(f.rec.finish(1101)).rejects.toThrow("ptt-too-long");
  });

  test("local ring rejection/unavailable window falls back to full exact cloud clip, preserving baseline proof", async () => {
    const f = fixture({
      local: true,
      request: async () => {
        throw Error("run incomplete");
      },
    });
    f.rec.frame(new Float32Array(20), 1000);
    const result = await f.rec.finish(1020);
    expect(result.text).toBe("stream 1");
    expect(result.recheck?.engine).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(result.speakerProof).toEqual(["proof-1"]);
    expect(f.calls[0]!.audio).toHaveLength(20);
    const invalid = fixture({
      local: true,
      request: async () => ({
        ok: true,
        auto: true,
        run: "other-run",
        text: "wrong",
        engine: "wrong",
      }),
    });
    invalid.rec.frame(new Float32Array(1), 1000);
    expect((await invalid.rec.finish(1001)).recheck?.text).toBe("whole cloud");
  });

  test("local setup/frame/end failures cannot silently submit a prefix as the whole transcript", async () => {
    for (const problem of [
      { beginNull: true },
      { beginThrow: true },
      { frameThrow: true },
      { endThrow: true },
      { endReject: true },
    ]) {
      const f = fixture({ local: true, ...problem });
      f.rec.frame(new Float32Array(3000), 1000);
      await tick();
      f.now(4100);
      const out = await f.rec.finish(4000);
      expect(out.text).toBe("whole cloud");
      expect(out.stt?.route).toBe("cloud");
      expect(out.stt?.fallback).toBe(true);
      expect(out.speakerProof).toBeUndefined();
    }
  });

  test("filtered audio never falls through to cloud, empty capture never transcribes", async () => {
    const f = fixture({ local: true, final: () => final("", { filtered: { reason: "other" } }) });
    f.rec.frame(new Float32Array(10), 1000);
    await expect(f.rec.finish(1010)).rejects.toThrow("ptt-filtered");
    expect(f.calls).toEqual([]);
    const empty = fixture({ local: true });
    const out = await empty.rec.finish(1000);
    expect(out.text).toBe("");
    expect(empty.calls).toEqual([]);
    expect(empty.cancelled()).toBe(1);
  });

  test("external cloud deadline aborts even a provider that ignores cancellation", async () => {
    const deadline = new AbortController();
    const f = fixture({ timeout: () => deadline.signal, cloud: () => new Promise(() => {}) });
    f.rec.frame(new Float32Array(10), 1000);
    const finished = f.rec.finish(1010);
    await tick();
    deadline.abort(new Error("deadline"));
    await expect(finished).rejects.toThrow("deadline");
    expect(f.calls[0]!.signal.aborted).toBe(true);
  });

  test("HQ failure keeps a complete local baseline; no model is invented for mixed engine segments", async () => {
    const f = fixture({
      local: true,
      segmentMs: 10,
      recheck: false,
      final: (i) => final(`part ${i}`, { model: `engine-${i}` }),
      cloud: async () => {
        throw Error("cloud down");
      },
    });
    f.rec.frame(new Float32Array(15), 1000);
    const out = await f.rec.finish(1015);
    expect(out.text).toBe("part 0 part 1");
    expect(out.stt).toEqual({ route: "local" });
    expect(out.recheck).toBeUndefined();
  });
});
