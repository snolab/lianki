import { describe, expect, test } from "bun:test";
import {
  createLocalStt,
  localSttRoute,
  packPcm,
  type WsLike,
} from "../packages/debug-chat/src/local-stt";
import {
  WEBGPU_STT_URL,
  createWebGpuModelManager,
  defaultProbeWebGpu,
  openWebGpuStt,
  type WebGpuCache,
  type WebGpuEngine,
} from "../packages/debug-chat/src/webgpu-stt";

function memoryCache(): WebGpuCache & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async get(k) {
      return map.get(k) ?? null;
    },
    async put(k, d) {
      map.set(k, d);
    },
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

describe("WebGpuModelManager", () => {
  test("downloads once on demand, emits progress, caches weights, and unloads when idle", async () => {
    const cache = memoryCache();
    const eng = fakeEngine();
    let fetches = 0;
    let idleCb: (() => void) | null = null;
    let readyEvents = 0;
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const statuses: string[] = [];

    const mgr = createWebGpuModelManager({
      modelId: "test/whisper-tiny",
      cacheMb: 10,
      idleUnloadMs: 5000,
      cache,
      engine: eng,
      probe: async () => ({ supported: true }),
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
      fetch: async () => {
        fetches++;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(payload.slice(0, 3));
            ctrl.enqueue(payload.slice(3));
            ctrl.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-length": String(payload.byteLength) },
        });
      },
    });
    mgr.subscribe((s) => statuses.push(`${s.status}:${s.progress.pct}`));

    expect(await mgr.ensureReady()).toBe(true);
    expect(fetches).toBe(1);
    expect(eng.loads).toBe(1);
    expect(readyEvents).toBe(1);
    expect(statuses).toContain("downloading:50");
    expect(statuses).toContain("ready:100");

    // Idle timer unloads GPU memory while keeping cached weights.
    expect(idleCb).not.toBeNull();
    idleCb!();
    expect(eng.unloads).toBe(1);
    expect(mgr.status()).toBe("idle");

    // Subsequent ensureReady hits cache without fetching.
    expect(await mgr.ensureReady()).toBe(true);
    expect(fetches).toBe(1);
    expect(eng.loads).toBe(2);
  });

  test("rejects downloads exceeding cacheMb limit", async () => {
    const mgr = createWebGpuModelManager({
      cacheMb: 1,
      cache: memoryCache(),
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

  test("reports model size before first download via HEAD", async () => {
    const mgr = createWebGpuModelManager({
      modelUrl: "https://cdn.example/whisper-tiny/v1.0.0/encoder_model.onnx",
      cacheMb: 256,
      cache: memoryCache(),
      engine: fakeEngine(),
      fetch: async (_url, init) => {
        expect(init?.method).toBe("HEAD");
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(40 * 1024 * 1024) },
        });
      },
    });
    const est = await mgr.estimateSize();
    expect(est).toEqual({ bytes: 40 * 1024 * 1024, label: "40.0 MB", maxMb: 256 });
    expect(mgr.snapshot().sizeLabel).toBe("40.0 MB");
  });
});

describe("webgpu:local race integration", () => {
  test("localSttRoute allows webgpu:local only when named=true", () => {
    expect(localSttRoute(WEBGPU_STT_URL, false, false)).toEqual({ source: "off" });
    expect(localSttRoute(WEBGPU_STT_URL, false, true)).toEqual({
      urls: WEBGPU_STT_URL,
      source: "stored",
    });
  });

  test("falls through to server route while downloading in background, then wins once ready", async () => {
    const cache = memoryCache();
    const eng = fakeEngine();
    let resolveFetch!: (r: Response) => void;
    const mgr = createWebGpuModelManager({
      cacheMb: 10,
      cache,
      engine: eng,
      probe: async () => ({ supported: true }),
      fetch: () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    });

    // Race 1: webgpu:local is idle -> kicks off background download and immediately yields to fallback server.
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

    // Finish background download -> manager becomes ready.
    resolveFetch(new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.status()).toBe("ready");

    // Race 2: webgpu:local is ready -> wins race and transcribes utterance end-to-end.
    const stt2 = createLocalStt([WEBGPU_STT_URL], {
      open: (u) => {
        expect(u).toBe(WEBGPU_STT_URL);
        return openWebGpuStt(mgr);
      },
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
});
