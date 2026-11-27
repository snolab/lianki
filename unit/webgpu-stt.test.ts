import { describe, expect, test } from "bun:test";
import { createLocalStt, localSttRoute, type WsLike } from "../packages/debug-chat/src/local-stt";
import {
  DEFAULT_WEBGPU_MODEL_URL,
  WEBGPU_STT_URL,
  createDefaultWebGpuEngine,
  createWebGpuModelManager,
  decodeWhisperTokens,
  defaultProbeWebGpu,
  extractWhisperFeatures,
  formatModelSize,
  getSharedWebGpuManager,
  modelAssetUrls,
  openWebGpuStt,
  parseWhisperTokenizer,
  type OrtLike,
  type WebGpuEngine,
} from "../packages/debug-chat/src/webgpu-stt";

function memoryCacheApi(): () => Promise<Pick<Cache, "match" | "put" | "delete">> {
  const map = new Map<string, Response>();
  const keyOf = (req: RequestInfo | URL) =>
    typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
  const api: Pick<Cache, "match" | "put" | "delete"> = {
    async match(req) {
      return map.get(keyOf(req))?.clone();
    },
    async put(req, res) {
      map.set(keyOf(req), res);
    },
    async delete(req) {
      return map.delete(keyOf(req));
    },
  };
  return async () => api;
}

function fakeEngine(
  over: Partial<WebGpuEngine> = {},
): WebGpuEngine & { loads: number; unloads: number } {
  const eng = {
    loads: 0,
    unloads: 0,
    async load() {
      eng.loads++;
    },
    partial(_id: number, pcm: Float32Array) {
      return pcm.length > 0 ? "par" : null;
    },
    async final(_id: number, pcm: Float32Array) {
      return { text: `final:${pcm.length}`, lang: "en", ms: 12 };
    },
    unload() {
      eng.unloads++;
    },
    ...over,
  };
  return eng;
}

describe("WebGPU probe", () => {
  test("reports no-webgpu, no-adapter, and quota-exceeded cleanly", async () => {
    const origNav = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
      expect(await defaultProbeWebGpu(128)).toEqual({ supported: false, reason: "no-webgpu" });

      Object.defineProperty(globalThis, "navigator", {
        value: { gpu: { requestAdapter: async () => null } },
        configurable: true,
      });
      expect(await defaultProbeWebGpu(128)).toEqual({ supported: false, reason: "no-adapter" });

      Object.defineProperty(globalThis, "navigator", {
        value: {
          gpu: {
            requestAdapter: async () => {
              throw new Error("gpu-err");
            },
          },
        },
        configurable: true,
      });
      expect(await defaultProbeWebGpu(128)).toEqual({ supported: false, reason: "no-adapter" });

      Object.defineProperty(globalThis, "navigator", {
        value: {
          gpu: { requestAdapter: async () => ({}) },
          storage: {
            estimate: async () => ({ quota: 100 * 1024 * 1024, usage: 50 * 1024 * 1024 }),
          },
        },
        configurable: true,
      });
      expect(await defaultProbeWebGpu(128)).toEqual({
        supported: false,
        reason: "quota-exceeded",
        quotaMb: 50,
      });
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true });
    }
  });
});

describe("WebGpuModelManager & model-download confirm/cancel", () => {
  test("shows size first, confirms metered/unknown network, caches weights, and unloads when idle", async () => {
    const cache = memoryCacheApi();
    const eng = fakeEngine();
    let gets = 0;
    let idleCb: (() => void) | null = null;
    let readyEvents = 0;
    const confirmed: { estimatedMb: number; risk: string }[] = [];
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);

    const mgr = createWebGpuModelManager({
      modelId: "test/whisper-tiny",
      modelUrl: "https://cdn.example/model.onnx",
      cacheMb: 10,
      idleUnloadMs: 5000,
      cache,
      engine: eng,
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "cellular" } }),
      confirmDownload: (d) => {
        confirmed.push(d);
        return true;
      },
      setTimer: (fn) => {
        idleCb = fn;
        return 1;
      },
      clearTimer: () => {
        idleCb = null;
      },
      onReadyEvent: () => {
        readyEvents++;
      },
      fetch: async (_url, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(3 * 1024 * 1024) },
          });
        }
        gets++;
        return new Response(payload, { status: 200 });
      },
    });

    expect(await mgr.ensureReady()).toBe(true);
    expect(confirmed).toEqual([{ estimatedMb: 3, risk: "restricted" }]);
    expect(mgr.snapshot().sizeLabel).toBe("6 B");
    expect(gets).toBe(1);
    expect(eng.loads).toBe(1);
    expect(readyEvents).toBe(1);

    // Idle timer unloads GPU memory while keeping cached weights.
    expect(idleCb).not.toBeNull();
    idleCb!();
    expect(eng.unloads).toBe(1);
    expect(mgr.status()).toBe("idle");

    // Subsequent ensureReady hits cache without calling GET fetch.
    expect(await mgr.ensureReady()).toBe(true);
    expect(gets).toBe(1);
    expect(eng.loads).toBe(2);
  });

  test("declining metered/unknown-network confirm blocks download without fetching model", async () => {
    let gets = 0;
    const mgr = createWebGpuModelManager({
      modelUrl: "https://cdn.example/model.onnx",
      cacheMb: 256,
      cache: memoryCacheApi(),
      engine: fakeEngine(),
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "cellular" } }),
      confirmDownload: () => false,
      fetch: async (_url, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(40 * 1024 * 1024) },
          });
        }
        gets++;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.status()).toBe("blocked");
    expect(gets).toBe(0);
    expect(mgr.snapshot().sizeLabel).toBe("40.0 MB");
  });

  test("rejects downloads exceeding cacheMb limit", async () => {
    const mgr = createWebGpuModelManager({
      cacheMb: 1,
      cache: memoryCacheApi(),
      engine: fakeEngine(),
      probe: async () => ({ supported: true }),
      fetch: async () =>
        new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.status()).toBe("error");
    expect(mgr.snapshot().error).toBe("model-exceeds-cache-limit");
  });
});

describe("real lazy WebGPU engine factory & race integration", () => {
  test("localSttRoute allows webgpu:local only when named=true", () => {
    expect(localSttRoute(WEBGPU_STT_URL, false, false)).toEqual({ source: "off" });
    expect(localSttRoute(WEBGPU_STT_URL, false, true)).toEqual({
      urls: WEBGPU_STT_URL,
      source: "stored",
    });
  });

  test("real createDefaultWebGpuEngine runs full Whisper pipeline (mel -> encoder -> autoregressive decoder -> BPE decode) and releases both sessions", async () => {
    let ortImports = 0;
    let released = 0;
    const createdProviders: (string[] | undefined)[] = [];
    const encoderBuf = new Uint8Array([1, 2]);
    const decoderBuf = new Uint8Array([3, 4]);
    const tokenizerBytes = new TextEncoder().encode(
      JSON.stringify({
        model: { vocab: { hello: 10, Ġworld: 11 } },
        added_tokens: [
          { id: 50257, content: "<|endoftext|>", special: true },
          { id: 50258, content: "<|startoftranscript|>", special: true },
          { id: 50359, content: "<|transcribe|>", special: true },
          { id: 50363, content: "<|notimestamps|>", special: true },
        ],
      }),
    );
    const configBytes = new TextEncoder().encode(
      JSON.stringify({ decoder_start_token_id: 50258, eos_token_id: 50257 }),
    );

    // Verify pure feature extraction & tokenizer directly.
    const pcmSample = new Float32Array(320).map((_, i) => Math.sin(i * 0.1));
    const mel = extractWhisperFeatures(pcmSample, 8);
    expect(mel.dims).toEqual([1, 80, 8]);
    expect(mel.data.length).toBe(640);
    expect(mel.data.every((v) => Number.isFinite(v))).toBe(true);
    const tok = parseWhisperTokenizer(tokenizerBytes, configBytes);
    expect(decodeWhisperTokens([50258, 10, 11, 50257], tok)).toBe("hello world");

    let step = 0;
    const fakeOrt: OrtLike = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array | BigInt64Array | Uint8Array | boolean[],
          public dims: number[],
        ) {}
      },
      InferenceSession: {
        async create(buf, opts) {
          createdProviders.push(opts?.executionProviders);
          if (buf[0] === 1) {
            return {
              inputNames: ["input_features"],
              outputNames: ["last_hidden_state"],
              async run(feeds) {
                const t = feeds.input_features as { dims: number[] };
                expect(t.dims).toEqual([1, 80, 8]);
                return {
                  last_hidden_state: { data: new Float32Array([0.5, 0.25]), dims: [1, 2, 1] },
                };
              },
              async release() {
                released++;
              },
            };
          }
          return {
            inputNames: ["input_ids", "encoder_hidden_states"],
            outputNames: ["logits"],
            async run() {
              const vocabSize = 50259;
              const logits = new Float32Array(vocabSize).fill(-10);
              const next = step === 0 ? 10 : step === 1 ? 11 : 50257;
              step++;
              logits[next] = 10;
              return { logits: { data: logits, dims: [1, 1, vocabSize] } };
            },
            async release() {
              released++;
            },
          };
        },
      },
    };

    const realEngine = createDefaultWebGpuEngine({
      melFrames: 8,
      importOrt: async () => {
        ortImports++;
        return fakeOrt;
      },
    });

    const mgr = createWebGpuModelManager({
      modelUrl: DEFAULT_WEBGPU_MODEL_URL,
      cacheMb: 10,
      cache: memoryCacheApi(),
      engine: realEngine,
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "wifi" } }),
      fetch: async (url, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "1024" } });
        }
        if (url.endsWith("encoder_model_quantized.onnx")) return new Response(encoderBuf);
        if (url.endsWith("decoder_model_merged_quantized.onnx")) return new Response(decoderBuf);
        if (url.endsWith("tokenizer.json")) return new Response(tokenizerBytes);
        return new Response(configBytes);
      },
    });

    expect(modelAssetUrls(DEFAULT_WEBGPU_MODEL_URL)).toHaveLength(4);
    expect(ortImports).toBe(0);
    expect(await mgr.ensureReady()).toBe(true);
    expect(ortImports).toBe(1);
    expect(createdProviders).toEqual([["webgpu"], ["webgpu"]]);

    const stt = createLocalStt([WEBGPU_STT_URL], {
      open: () => openWebGpuStt(mgr),
    });
    stt.warm();
    await new Promise((r) => setTimeout(r, 10));
    const utt = stt.begin(() => {})!;
    utt.frame(pcmSample);
    const fin = await utt.end(pcmSample);
    expect(fin.text).toBe("hello world");
    expect(fin.signals?.decoder).toBe("whisper");
    stt.close();

    await realEngine.unload?.();
    expect(released).toBe(2);
  });

  test("falls through to server route while downloading in background, then wins once ready", async () => {
    const cache = memoryCacheApi();
    const eng = fakeEngine();
    let resolveFetch!: (r: Response) => void;
    const mgr = createWebGpuModelManager({
      modelUrl: "https://cdn.example/model.onnx",
      cacheMb: 10,
      cache,
      engine: eng,
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "wifi" } }),
      fetch: (_url, init) => {
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { status: 200, headers: { "content-length": "3" } }),
          );
        }
        return new Promise<Response>((res) => {
          resolveFetch = res;
        });
      },
    });

    const events: Record<string, unknown>[] = [];
    const stt1 = createLocalStt([WEBGPU_STT_URL, "wss://fallback.example/stt"], {
      log: (ev) => events.push(ev),
      open: (u) => {
        if (u === WEBGPU_STT_URL) return openWebGpuStt(mgr);
        const sock: WsLike = {
          readyState: 1,
          binaryType: "arraybuffer",
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send() {},
          close() {
            sock.readyState = 3;
          },
        };
        queueMicrotask(() => {
          sock.onopen?.({});
          sock.onmessage?.({ data: JSON.stringify({ t: "ready", model: "fallback-server" }) });
        });
        return sock;
      },
    });
    stt1.warm();
    await new Promise((r) => setTimeout(r, 200));
    expect(stt1.connected()).toBe(true);
    expect(mgr.status()).toBe("downloading");
    expect(events.some((e) => e.state === "ready" && e.via === "fallback.example")).toBe(true);
    stt1.close();

    resolveFetch(new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.status()).toBe("ready");

    const stt2 = createLocalStt([WEBGPU_STT_URL], {
      open: () => openWebGpuStt(mgr),
    });
    stt2.warm();
    await new Promise((r) => setTimeout(r, 10));
    const partials: string[] = [];
    const utt = stt2.begin((t) => partials.push(t))!;
    const frame = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    utt.frame(frame);
    await new Promise((r) => setTimeout(r, 10));
    const fin = await utt.end(frame);
    expect(partials).toContain("par");
    expect(fin.text).toBe("final:4");
    expect(fin.signals?.decoder).toBe("whisper");
    stt2.close();
  });

  test("formatModelSize, getSharedWebGpuManager, cancelDownload, and error/cancel paths", async () => {
    expect(formatModelSize(512)).toBe("512 B");
    expect(formatModelSize(2048)).toBe("2 KB");
    expect(formatModelSize(5 * 1024 * 1024)).toBe("5.0 MB");

    const eng = createDefaultWebGpuEngine();
    await expect(eng.final(1, new Float32Array([0.1]))).rejects.toThrow("webgpu-engine-not-loaded");

    const s1 = getSharedWebGpuManager({
      modelUrl: "https://cdn.example/a.onnx",
      cacheMb: 64,
      idleUnloadMs: 120_000,
    });
    const s2 = getSharedWebGpuManager({ confirmDownload: () => true });
    expect(s2).toBe(s1);
    expect((await s2.estimateSize()).maxMb).toBe(64);
    const s3 = getSharedWebGpuManager({ modelUrl: "https://cdn.example/b.onnx", cacheMb: 64 });
    expect(s3).not.toBe(s1);
    const seenSnaps: string[] = [];
    const unsub = s3.subscribe((s) => seenSnaps.push(s.status));
    unsub();

    // cancelDownload aborts in-flight fetch cleanly.
    const cancelMgr = createWebGpuModelManager({
      cache: memoryCacheApi(),
      engine: fakeEngine(),
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "wifi" } }),
      fetch: (_url, init) => {
        if (init?.method === "HEAD") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      },
    });
    const p = cancelMgr.ensureReady();
    await new Promise((r) => setTimeout(r, 10));
    cancelMgr.cancelDownload();
    expect(await p).toBe(false);
    expect(["idle", "blocked"]).toContain(cancelMgr.status());

    // openWebGpuStt handles cancel and engine error cleanly.
    const errMgr = createWebGpuModelManager({
      cache: memoryCacheApi(),
      engine: fakeEngine({
        async final() {
          throw new Error("boom");
        },
      }),
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "wifi" } }),
      fetch: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });
    expect(await errMgr.ensureReady()).toBe(true);
    const sock = openWebGpuStt(errMgr);
    const msgs: string[] = [];
    sock.onmessage = (e) => msgs.push(String(e.data));
    await new Promise((r) => setTimeout(r, 10));
    sock.send(JSON.stringify({ t: "begin", id: 1 }));
    sock.send(JSON.stringify({ t: "cancel", id: 1 }));
    sock.send(JSON.stringify({ t: "begin", id: 2 }));
    sock.send(JSON.stringify({ t: "end", id: 2 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(msgs.some((m) => m.includes('"error":"boom"'))).toBe(true);
    sock.close();
  });

  test("extractWhisperFeatures matches WhisperFeatureExtractor 30s padding, trimming, and log-mel numerics", () => {
    const pcm = new Float32Array(1600);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    }
    const feat = extractWhisperFeatures(pcm);
    expect(feat.dims).toEqual([1, 80, 3000]);
    expect(feat.data.length).toBe(240_000);

    const at = (m: number, f: number) => feat.data[m * 3000 + f]!;
    const expectClose = (actual: number, expected: number) => {
      expect(Math.abs(actual - expected)).toBeLessThan(1e-4);
    };

    // Frame 0 (reflect-padded boundary), mels 0..4
    const refFrame0 = [0.98328, 0.98662, 0.99715, 1.00781, 1.02748];
    for (let m = 0; m < refFrame0.length; m++) expectClose(at(m, 0), refFrame0[m]!);

    // Frame 5 (440 Hz peak at mel bin 11, clamped floor = max - 2.0 = -0.56180)
    const refFrame5 = [1.15939, 1.34874, 1.4382, 1.29352, -0.5618];
    for (let i = 0; i < refFrame5.length; i++) expectClose(at(9 + i, 5), refFrame5[i]!);

    // Frame 20 (zero-padded 30s tail)
    for (let m = 0; m < 5; m++) expectClose(at(m, 20), -0.5618);

    // Signals longer than 30s (480,000 samples) are trimmed to [1, 80, 3000]
    const longPcm = new Float32Array(500_000);
    longPcm.set(pcm, 0);
    const longFeat = extractWhisperFeatures(longPcm);
    expect(longFeat.dims).toEqual([1, 80, 3000]);
    expectClose(longFeat.data[11 * 3000 + 5]!, 1.4382);
  });

  test("merged decoder feeds all decoderSession.inputNames with exact shapes on step 0 and step N", async () => {
    const tokenizerBytes = new TextEncoder().encode(
      JSON.stringify({
        model: {
          vocab: {
            "<|startoftranscript|>": 50258,
            "<|transcribe|>": 50359,
            "<|notimestamps|>": 50363,
            "<|endoftext|>": 50257,
            h: 100,
            i: 101,
          },
        },
        added_tokens: [
          { id: 50258, content: "<|startoftranscript|>", special: true },
          { id: 50359, content: "<|transcribe|>", special: true },
          { id: 50363, content: "<|notimestamps|>", special: true },
          { id: 50257, content: "<|endoftext|>", special: true },
        ],
      }),
    );
    const configBytes = new TextEncoder().encode(
      JSON.stringify({ num_mel_bins: 80, decoder_attention_heads: 6, d_model: 384 }),
    );

    const decInputNames = [
      "input_ids",
      "encoder_hidden_states",
      "past_key_values.0.decoder.key",
      "past_key_values.0.decoder.value",
      "use_cache_branch",
    ];
    const recordedFeeds: Array<Record<string, { dims?: number[]; data: ArrayLike<unknown> }>> = [];
    const emitted = [100, 101, 50257];
    let step = 0;

    class FakeTensor {
      type: string;
      data: Float32Array | BigInt64Array | Uint8Array | boolean[];
      dims: number[];
      constructor(
        type: string,
        data: Float32Array | BigInt64Array | Uint8Array | boolean[],
        dims: number[],
      ) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    }

    const engine = createDefaultWebGpuEngine({
      importOrt: async () => ({
        Tensor: FakeTensor,
        InferenceSession: {
          async create(modelBytes: Uint8Array) {
            if (modelBytes[0] === 1) {
              return {
                inputNames: ["input_features"],
                outputNames: ["last_hidden_state"],
                async run() {
                  return {
                    last_hidden_state: { data: new Float32Array(1500 * 384), dims: [1, 1500, 384] },
                  };
                },
              };
            }
            return {
              inputNames: decInputNames,
              outputNames: ["logits", "present.0.decoder.key", "present.0.decoder.value"],
              async run(feeds: Record<string, unknown>) {
                recordedFeeds.push(
                  feeds as Record<string, { dims?: number[]; data: ArrayLike<unknown> }>,
                );
                const tok = emitted[step] ?? 50257;
                step++;
                const seqLen = step === 1 ? 3 : 1;
                const logits = new Float32Array(seqLen * 50365);
                logits[(seqLen - 1) * 50365 + tok] = 10;
                return {
                  logits: { data: logits, dims: [1, seqLen, 50365] },
                  "present.0.decoder.key": {
                    data: new Float32Array(6 * step * 64),
                    dims: [1, 6, step, 64],
                  },
                  "present.0.decoder.value": {
                    data: new Float32Array(6 * step * 64),
                    dims: [1, 6, step, 64],
                  },
                };
              },
            };
          },
        },
      }),
    });

    await engine.load("test-whisper", {
      encoder: new Uint8Array([1]),
      decoder: new Uint8Array([2]),
      tokenizerJson: tokenizerBytes,
      configJson: configBytes,
    });
    const out = await engine.final(1, new Float32Array(1600));
    expect(out.text).toBe("hi");
    expect(recordedFeeds).toHaveLength(3);

    const expectedKeys = [...decInputNames].sort();
    for (let s = 0; s < recordedFeeds.length; s++) {
      const f = recordedFeeds[s]!;
      expect(Object.keys(f).sort()).toEqual(expectedKeys);
      expect(f["use_cache_branch"]!.data[0]).toBe(s > 0);
      expect(f["use_cache_branch"]!.dims).toEqual([1]);
      expect(f["input_ids"]!.dims).toEqual([1, s === 0 ? 3 : 1]);
      expect(f["past_key_values.0.decoder.key"]!.dims).toEqual([1, 6, s, 64]);
      expect(f["past_key_values.0.decoder.value"]!.dims).toEqual([1, 6, s, 64]);
    }
    await engine.unload?.();
  });
});
