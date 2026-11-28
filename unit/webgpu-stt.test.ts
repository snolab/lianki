import { describe, expect, test } from "bun:test";
import { createLocalStt, localSttRoute, type WsLike } from "../packages/debug-chat/src/local-stt";
import type { ModelNetwork } from "../packages/debug-chat/src/model-download";
import {
  DEFAULT_WEBGPU_MODEL_URL,
  DEFAULT_WEBGPU_ESTIMATED_MB,
  DEFAULT_WEBGPU_ORT_ESTIMATED_MB,
  DEFAULT_WEBGPU_ORT_MJS_BYTES,
  DEFAULT_WEBGPU_ORT_MJS_SHA256,
  DEFAULT_WEBGPU_ORT_WASM_BYTES,
  DEFAULT_WEBGPU_ORT_WASM_BASE,
  DEFAULT_WEBGPU_ORT_WASM_SHA256,
  WEBGPU_ORT_MJS_FILE,
  WEBGPU_ORT_WASM_FILE,
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

// Stand-in ORT runtime files and their pinned hashes: the manager downloads them
// with the model through the same guard and verifies them.
const ORT_MJS = new TextEncoder().encode("export default {}");
const ORT_WASM = new Uint8Array([0, 97, 115, 109]);
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const ortDeps = { ortMjsSha256: sha256(ORT_MJS), ortWasmSha256: sha256(ORT_WASM) };
type TestFetch = (url: string, init?: RequestInit) => Promise<Response>;
function withOrt(f: TestFetch): TestFetch {
  return (url, init) => {
    if (init?.method !== "HEAD" && url.endsWith(WEBGPU_ORT_MJS_FILE)) {
      return Promise.resolve(new Response(ORT_MJS));
    }
    if (init?.method !== "HEAD" && url.endsWith(WEBGPU_ORT_WASM_FILE)) {
      return Promise.resolve(new Response(ORT_WASM));
    }
    return f(url, init);
  };
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
    const confirmed: { estimatedMb: number; risk: string; signal?: AbortSignal }[] = [];
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
      ...ortDeps,
      fetch: withOrt(async (_url, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(3 * 1024 * 1024) },
          });
        }
        gets++;
        return new Response(payload, { status: 200 });
      }),
    });

    expect(await mgr.ensureReady()).toBe(true);
    // Cellular: no HEAD before the confirm, so the fallback total (capped at cacheMb).
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ estimatedMb: 10, risk: "restricted" });
    expect(confirmed[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(mgr.snapshot().sizeLabel).toBe(
      formatModelSize(payload.byteLength + ORT_MJS.byteLength + ORT_WASM.byteLength),
    );
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
      ...ortDeps,
      fetch: withOrt(async (_url, init) => {
        gets++;
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(40 * 1024 * 1024) },
          });
        }
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      }),
    });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.status()).toBe("blocked");
    expect(gets).toBe(0);
    expect(mgr.snapshot().sizeLabel).toBeUndefined();
  });

  test("rejects downloads exceeding cacheMb limit", async () => {
    const mgr = createWebGpuModelManager({
      cacheMb: 1,
      cache: memoryCacheApi(),
      engine: fakeEngine(),
      probe: async () => ({ supported: true }),
      network: () => ({ online: true, connection: { type: "wifi" } }),
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
      ...ortDeps,
      fetch: withOrt(async (url, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "1024" } });
        }
        if (url.endsWith("encoder_model_quantized.onnx")) return new Response(encoderBuf);
        if (url.endsWith("decoder_model_merged_quantized.onnx")) return new Response(decoderBuf);
        if (url.endsWith("tokenizer.json")) return new Response(tokenizerBytes);
        return new Response(configBytes);
      }),
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
      ...ortDeps,
      fetch: withOrt((_url, init) => {
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { status: 200, headers: { "content-length": "3" } }),
          );
        }
        return new Promise<Response>((res) => {
          resolveFetch = res;
        });
      }),
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
      ...ortDeps,
      fetch: withOrt((_url, init) => {
        if (init?.method === "HEAD") {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }),
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
      ...ortDeps,
      fetch: withOrt(async () => new Response(new Uint8Array([1, 2]), { status: 200 })),
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
      "past_key_values.0.encoder.key",
      "past_key_values.0.encoder.value",
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
              outputNames: [
                "logits",
                "present.0.decoder.key",
                "present.0.decoder.value",
                "present.0.encoder.key",
                "present.0.encoder.value",
              ],
              async run(feeds: Record<string, unknown>) {
                recordedFeeds.push(
                  feeds as Record<string, { dims?: number[]; data: ArrayLike<unknown> }>,
                );
                const tok = emitted[step] ?? 50257;
                const isFirst = step === 0;
                step++;
                const seqLen = isFirst ? 3 : 1;
                const encSeq = isFirst ? 1500 : 0;
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
                  "present.0.encoder.key": {
                    data: new Float32Array(6 * encSeq * 64),
                    dims: [1, 6, encSeq, 64],
                  },
                  "present.0.encoder.value": {
                    data: new Float32Array(6 * encSeq * 64),
                    dims: [1, 6, encSeq, 64],
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
      const expectedEncDims = s === 0 ? [1, 6, 0, 64] : [1, 6, 1500, 64];
      expect(f["past_key_values.0.encoder.key"]!.dims).toEqual(expectedEncDims);
      expect(f["past_key_values.0.encoder.value"]!.dims).toEqual(expectedEncDims);
    }
    await engine.unload?.();
  });
});

describe("ORT runtime: pinned, guarded, verified, handed over as bytes", () => {
  const pkg = require("../package.json") as { dependencies?: Record<string, string> };
  type Env = { wasm: { wasmPaths?: unknown; wasmBinary?: unknown; numThreads?: number } };
  const fakeOrt = (env: Env): OrtLike => ({
    env,
    Tensor: class {} as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create() {
        return {
          async run() {
            return {};
          },
        };
      },
    },
  });
  const model = { encoder: new Uint8Array([1]), decoder: new Uint8Array([2]) };

  test("defaults are pinned to the exact installed onnxruntime-web", () => {
    const v = pkg.dependencies?.["onnxruntime-web"];
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DEFAULT_WEBGPU_ORT_WASM_BASE).toBe(
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${v}/dist/`,
    );
    // The installed files are the ones the CDN serves for that version.
    const dist = `${import.meta.dir}/../node_modules/onnxruntime-web/dist/`;
    const fs = require("fs") as typeof import("fs");
    if (fs.existsSync(dist + WEBGPU_ORT_WASM_FILE)) {
      expect(sha256(fs.readFileSync(dist + WEBGPU_ORT_MJS_FILE))).toBe(
        DEFAULT_WEBGPU_ORT_MJS_SHA256,
      );
      expect(sha256(fs.readFileSync(dist + WEBGPU_ORT_WASM_FILE))).toBe(
        DEFAULT_WEBGPU_ORT_WASM_SHA256,
      );
    }
  });

  test("load() hands ORT the verified bytes and a module URL, single-threaded, then revokes it", async () => {
    const env: Env = { wasm: {} };
    const made: Uint8Array[] = [];
    let revoked = 0;
    const engine = createDefaultWebGpuEngine({
      importOrt: async () => fakeOrt(env),
      moduleUrl: (b) => {
        made.push(b);
        return { url: "blob:verified-glue", revoke: () => revoked++ };
      },
    });
    await engine.load("m", { ...model, ortMjs: ORT_MJS, ortWasm: ORT_WASM });
    expect(env.wasm.wasmBinary).toBe(ORT_WASM);
    expect(env.wasm.wasmPaths).toEqual({ mjs: "blob:verified-glue" });
    expect(env.wasm.numThreads).toBe(1);
    expect(made).toEqual([ORT_MJS]);
    expect(revoked).toBe(1);
  });

  test("load() refuses a real ORT without verified runtime bytes (ORT never fetches its own)", async () => {
    const env: Env = { wasm: {} };
    const engine = createDefaultWebGpuEngine({ importOrt: async () => fakeOrt(env) });
    await expect(engine.load("m", model)).rejects.toThrow("webgpu-ort-runtime-unverified");
    expect(env.wasm.wasmPaths).toBeUndefined();
  });

  const managerWith = (o: {
    fetch: TestFetch;
    engine?: WebGpuEngine;
    confirm?: (d: { estimatedMb: number }) => boolean;
    network?: string | (() => ModelNetwork);
    cache?: ReturnType<typeof memoryCacheApi>;
    pinned?: boolean;
  }) =>
    createWebGpuModelManager({
      modelUrl: "https://cdn.example/model.onnx",
      ortWasmBase: "https://cdn.example/ort",
      ...(o.pinned ? {} : ortDeps),
      cacheMb: 256,
      cache: o.cache ?? memoryCacheApi(),
      engine: o.engine ?? fakeEngine(),
      probe: async () => ({ supported: true }),
      network: ((n) =>
        typeof n === "function" ? n : () => ({ online: true, connection: { type: n ?? "wifi" } }))(
        o.network,
      ),
      ...(o.confirm ? { confirmDownload: o.confirm } : {}),
      fetch: o.fetch,
    });

  test("on cellular the confirm total includes the ORT runtime, and nothing is requested first", async () => {
    let requests = 0;
    const confirmed: number[] = [];
    const mgr = managerWith({
      pinned: true,
      network: "cellular",
      confirm: (d) => {
        confirmed.push(d.estimatedMb);
        return false;
      },
      fetch: async () => {
        requests++;
        throw new Error("nothing may be requested before the confirm");
      },
    });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.status()).toBe("blocked");
    // Model fallback (44 MB) + runtime (26 MB).
    expect(confirmed).toEqual([DEFAULT_WEBGPU_ESTIMATED_MB + DEFAULT_WEBGPU_ORT_ESTIMATED_MB]);
    expect(requests).toBe(0);
  });

  test("model cached, runtime cold, on cellular: zero requests without a confirm, and none after a refusal", async () => {
    for (const confirm of [undefined, () => false]) {
      const cache = memoryCacheApi();
      const store = await cache();
      await store.put("https://cdn.example/model.onnx", new Response(new Uint8Array([1, 2, 3])));
      let requests = 0;
      const confirmed: number[] = [];
      const mgr = managerWith({
        pinned: true,
        cache,
        network: "cellular",
        ...(confirm
          ? {
              confirm: (d: { estimatedMb: number }) => {
                confirmed.push(d.estimatedMb);
                return confirm();
              },
            }
          : {}),
        fetch: async () => {
          requests++;
          return new Response(null, { status: 200 });
        },
      });
      expect(await mgr.ensureReady()).toBe(false);
      expect(mgr.status()).toBe("blocked");
      expect(requests).toBe(0);
      // Only the runtime is missing: its exact pinned size, 26,874,157 bytes.
      if (confirm) {
        expect(confirmed).toEqual([
          Math.ceil((DEFAULT_WEBGPU_ORT_MJS_BYTES + DEFAULT_WEBGPU_ORT_WASM_BYTES) / (1024 * 1024)),
        ]);
      }
    }
  });

  test("on an unmetered network the HEAD size covers the model and both runtime files", async () => {
    const heads: string[] = [];
    const sizes: Record<string, number> = {
      "https://cdn.example/model.onnx": 40 * 1024 * 1024,
      [`https://cdn.example/ort/${WEBGPU_ORT_MJS_FILE}`]: DEFAULT_WEBGPU_ORT_MJS_BYTES,
      [`https://cdn.example/ort/${WEBGPU_ORT_WASM_FILE}`]: DEFAULT_WEBGPU_ORT_WASM_BYTES,
    };
    const mgr = managerWith({
      fetch: async (url, init) => {
        heads.push(`${init?.method}:${url}`);
        return new Response(null, { headers: { "content-length": String(sizes[url] ?? 0) } });
      },
    });
    const est = await mgr.estimateSize();
    expect(heads.sort()).toEqual(
      Object.keys(sizes)
        .map((u) => `HEAD:${u}`)
        .sort(),
    );
    // 41,943,040 + 46,614 + 26,827,543 bytes.
    expect(est.label).toBe("65.6 MB");
  });

  test("a runtime file with the wrong SHA-256 is refused and never reaches ORT", async () => {
    const eng = fakeEngine();
    const mgr = managerWith({
      engine: eng,
      fetch: async (url, init) => {
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        if (url.endsWith(WEBGPU_ORT_WASM_FILE)) return new Response(new Uint8Array([6, 6, 6]));
        if (url.endsWith(WEBGPU_ORT_MJS_FILE)) return new Response(ORT_MJS);
        return new Response(new Uint8Array([1, 2]));
      },
    });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.status()).toBe("error");
    expect(mgr.snapshot().error).toBe("model-download-digest");
    expect(eng.loads).toBe(0);
  });

  test("cancelling during the ORT wasm download stops it and loads nothing", async () => {
    const eng = fakeEngine();
    const got: string[] = [];
    const mgr = managerWith({
      engine: eng,
      fetch: (url, init) => {
        if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
        got.push(url);
        if (!url.endsWith(WEBGPU_ORT_WASM_FILE)) {
          return Promise.resolve(
            new Response(url.endsWith(WEBGPU_ORT_MJS_FILE) ? ORT_MJS : new Uint8Array([1])),
          );
        }
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      },
    });
    const p = mgr.ensureReady();
    await new Promise((r) => setTimeout(r, 10));
    expect(got.at(-1)).toBe(`https://cdn.example/ort/${WEBGPU_ORT_WASM_FILE}`);
    mgr.cancelDownload();
    expect(await p).toBe(false);
    expect(["idle", "blocked"]).toContain(mgr.status());
    expect(eng.loads).toBe(0);
  });

  test("the verified runtime bytes reach the engine with the model", async () => {
    let seen: { ortMjs?: Uint8Array; ortWasm?: Uint8Array } | null = null;
    const mgr = managerWith({
      engine: fakeEngine({
        async load(_id, b) {
          seen = b as { ortMjs?: Uint8Array; ortWasm?: Uint8Array };
        },
      }),
      fetch: withOrt(async () => new Response(new Uint8Array([1]))),
    });
    expect(await mgr.ensureReady()).toBe(true);
    expect(seen!.ortMjs).toEqual(ORT_MJS);
    expect(seen!.ortWasm).toEqual(ORT_WASM);
  });

  const deferredEngine = () => {
    let finish!: () => void;
    const eng = fakeEngine();
    const signals: (AbortSignal | undefined)[] = [];
    eng.load = (_m, _b, o) =>
      new Promise<void>((res) => {
        eng.loads++;
        signals.push(o?.signal);
        finish = res;
      });
    return { eng, signals, finish: () => finish() };
  };

  test("a network change during engine.load cancels that load (its signal) and unloads nothing", async () => {
    let type = "wifi";
    let onChange: (() => void) | null = null;
    const connection = {
      get type() {
        return type;
      },
      addEventListener: (_t: string, fn: () => void) => {
        onChange = fn;
      },
      removeEventListener: () => {
        onChange = null;
      },
    };
    const { eng, signals, finish } = deferredEngine();
    const mgr = managerWith({
      engine: eng,
      network: () => ({ online: true, connection }),
      fetch: withOrt(async () => new Response(new Uint8Array([1]))),
    });
    const p = mgr.ensureReady();
    await new Promise((r) => setTimeout(r, 10));
    expect(eng.loads).toBe(1);
    type = "cellular";
    onChange!();
    expect(await p).toBe(false);
    expect(mgr.status()).toBe("blocked");
    expect(signals[0]?.aborted).toBe(true);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(eng.unloads).toBe(0);
    expect(onChange).toBeNull();
  });

  test("cancelDownload during engine.load ends it too", async () => {
    const { eng, signals, finish } = deferredEngine();
    const mgr = managerWith({
      engine: eng,
      fetch: withOrt(async () => new Response(new Uint8Array([1]))),
    });
    const p = mgr.ensureReady();
    await new Promise((r) => setTimeout(r, 10));
    expect(eng.loads).toBe(1);
    mgr.cancelDownload();
    expect(await p).toBe(false);
    expect(mgr.status()).toBe("idle");
    expect(signals[0]?.aborted).toBe(true);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(eng.unloads).toBe(0);
  });

  test("cancel, retry, retry ready, then the old load ends: the ready engine is untouched", async () => {
    const finishers: (() => void)[] = [];
    const eng = fakeEngine();
    eng.load = () =>
      new Promise<void>((res) => {
        eng.loads++;
        finishers.push(res);
      });
    const mgr = managerWith({
      engine: eng,
      fetch: withOrt(async () => new Response(new Uint8Array([1]))),
    });
    const first = mgr.ensureReady();
    await new Promise((r) => setTimeout(r, 10));
    mgr.cancelDownload();
    expect(await first).toBe(false);
    expect(eng.unloads).toBe(0);

    const retry = mgr.ensureReady();
    await new Promise((r) => setTimeout(r, 10));
    expect(eng.loads).toBe(2);
    finishers[1]!();
    expect(await retry).toBe(true);
    expect(mgr.status()).toBe("ready");

    // The cancelled first load ends only now: nothing unloads the retry's engine.
    finishers[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(eng.unloads).toBe(0);
    expect(mgr.status()).toBe("ready");
  });

  // A real engine over a fake ORT whose session creation the test controls.
  const controlledOrt = () => {
    const sessions: { tag: string; released: boolean }[] = [];
    const pending: { resolve: () => void; reject: (e: Error) => void; tag: string }[] = [];
    const ort: OrtLike = {
      Tensor: class {} as unknown as OrtLike["Tensor"],
      InferenceSession: {
        create(buf: Uint8Array) {
          const tag = `${String.fromCharCode(buf[0]!)}${pending.length}`;
          return new Promise((resolve, reject) => {
            pending.push({
              tag,
              reject,
              resolve: () => {
                const s = { tag, released: false };
                sessions.push(s);
                resolve({
                  inputNames: [],
                  outputNames: [],
                  async run() {
                    return {};
                  },
                  release() {
                    s.released = true;
                  },
                });
              },
            });
          });
        },
      },
    };
    return { ort, sessions, pending };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const bundleOf = (c: string) => ({
    encoder: new TextEncoder().encode(`${c}e`),
    decoder: new TextEncoder().encode(`${c}d`),
  });

  test("a superseded engine load releases only its own sessions, never the newer ones", async () => {
    const c = controlledOrt();
    const engine = createDefaultWebGpuEngine({ importOrt: async () => c.ort });
    const old = engine.load("m", bundleOf("o"));
    await tick();
    c.pending[0]!.resolve(); // old encoder built
    await tick();
    await engine.unload?.(); // cancelled while its decoder is still being built
    const retry = engine.load("m", bundleOf("n"));
    await tick();
    c.pending[2]!.resolve(); // retry encoder
    await tick();
    c.pending[3]!.resolve(); // retry decoder
    await retry;
    c.pending[1]!.resolve(); // old decoder ends last
    await expect(old).rejects.toThrow("webgpu-load-superseded");
    const byTag = Object.fromEntries(c.sessions.map((s) => [s.tag, s.released]));
    expect(byTag).toEqual({ o0: true, o1: true, n2: false, n3: false });
    // The retry's sessions are the live ones.
    await expect(engine.final(1, new Float32Array(160))).resolves.toBeDefined();
  });

  test("by default the verified glue is a blob URL, revoked once the sessions exist", async () => {
    const env: { wasm: { wasmPaths?: unknown } } = { wasm: {} };
    const c = controlledOrt();
    const engine = createDefaultWebGpuEngine({ importOrt: async () => ({ ...c.ort, env }) });
    const p = engine.load("m", { ...bundleOf("g"), ortMjs: ORT_MJS, ortWasm: ORT_WASM });
    await tick();
    const url = (env.wasm.wasmPaths as { mjs: string }).mjs;
    expect(url.startsWith("blob:")).toBe(true);
    c.pending[0]!.resolve();
    await tick();
    c.pending[1]!.resolve();
    await p;
    expect(
      await fetch(url).then(
        () => "live",
        () => "revoked",
      ),
    ).toBe("revoked");
  });

  test("a failed engine load releases its partial session and keeps the ready ones", async () => {
    const c = controlledOrt();
    const engine = createDefaultWebGpuEngine({ importOrt: async () => c.ort, maxTokens: 1 });
    const first = engine.load("m", bundleOf("a"));
    await tick();
    c.pending[0]!.resolve();
    await tick();
    c.pending[1]!.resolve();
    await first;
    const failing = engine.load("m", bundleOf("b"));
    await tick();
    c.pending[2]!.resolve(); // encoder built
    await tick();
    c.pending[3]!.reject(new Error("decoder-failed"));
    await expect(failing).rejects.toThrow("decoder-failed");
    const byTag = Object.fromEntries(c.sessions.map((s) => [s.tag, s.released]));
    expect(byTag).toEqual({ a0: false, a1: false, b2: true });
    await expect(engine.final(1, new Float32Array(160))).resolves.toBeDefined();
  });

  // codex's repro for #1157: an engine with no generation logic of its own.
  test("a cancelled old load cannot unload a newer ready engine (manager never unloads on cancel)", async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((r) => (started = r));
    let calls = 0;
    let usable = false;
    let unloads = 0;
    const engine: WebGpuEngine = {
      async load() {
        calls++;
        if (calls === 1) {
          started();
          await new Promise<void>((r) => (release = r));
        }
        usable = true;
      },
      async final() {
        if (!usable) throw new Error("unloaded");
        return { text: "ok" };
      },
      unload() {
        usable = false;
        unloads++;
      },
    };
    const m = managerWith({
      engine,
      fetch: withOrt(async () => new Response(new Uint8Array([1]))),
    });
    const first = m.ensureReady();
    await start;
    m.cancelDownload();
    expect(await first).toBe(false);
    expect(await m.ensureReady()).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.status()).toBe("ready");
    expect(unloads).toBe(0);
    expect((await engine.final(1, new Float32Array())).text).toBe("ok");
  });

  test("the real engine: an aborted load drops its own sessions, the retry's stay live", async () => {
    const c = controlledOrt();
    const engine = createDefaultWebGpuEngine({ importOrt: async () => c.ort });
    const ctrl = new AbortController();
    const old = engine.load("m", bundleOf("o"), { signal: ctrl.signal });
    await tick();
    c.pending[0]!.resolve(); // old encoder
    await tick();
    ctrl.abort(); // cancelled while its decoder is being built
    const retry = engine.load("m", bundleOf("n"));
    await tick();
    c.pending[2]!.resolve();
    await tick();
    c.pending[3]!.resolve();
    await retry;
    c.pending[1]!.resolve(); // the old decoder lands last
    await expect(old).rejects.toThrow("webgpu-load-superseded");
    const byTag = Object.fromEntries(c.sessions.map((s) => [s.tag, s.released]));
    expect(byTag).toEqual({ o0: true, o1: true, n2: false, n3: false });
    await expect(engine.final(1, new Float32Array(160))).resolves.toBeDefined();
  });

  test("the real engine: aborting a load after a newer one started changes nothing", async () => {
    const c = controlledOrt();
    const engine = createDefaultWebGpuEngine({ importOrt: async () => c.ort });
    const ctrl = new AbortController();
    ctrl.abort();
    const old = engine.load("m", bundleOf("o"), { signal: ctrl.signal });
    await tick();
    c.pending[0]!.resolve();
    await tick();
    c.pending[1]!.resolve();
    await expect(old).rejects.toThrow("webgpu-load-superseded");
    expect(c.sessions.every((s) => s.released)).toBe(true);
  });
});
