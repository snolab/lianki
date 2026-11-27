/**
 * Client-side WebGPU local speech-to-text (docs/local-stt.md, /stt/windows-webgpu):
 * - Probes WebGPU (`navigator.gpu.requestAdapter`) and storage quota.
 * - Estimates model size first (`HEAD`), then routes uncached downloads through
 *   `downloadModelAssets` (`model-download.ts`) for metered/unknown-network
 *   confirmation and network-change cancellation.
 * - Audio stays on the device ONLY on the `webgpu:local` route; when falling
 *   back to server or cloud routes, audio is sent to those routes as usual.
 */
import type { WsLike } from "./local-stt";
import { STT_AVAILABLE_EVENT } from "./public-stt";
import {
  downloadModelAssets,
  ModelDownloadBlocked,
  type ModelDownloadRisk,
  type ModelNetwork,
} from "./model-download";

export const WEBGPU_STT_URL = "webgpu:local";
export const WEBGPU_CACHE = "lianki-webgpu-stt-v1";
export const WEBGPU_READY_EVENT = STT_AVAILABLE_EVENT;
export const DEFAULT_WEBGPU_MODEL_ID = "onnx-community/whisper-tiny@v1.0.0";
export const DEFAULT_WEBGPU_MODEL_URL =
  "https://huggingface.co/onnx-community/whisper-tiny/resolve/v1.0.0/onnx/encoder_model.onnx";
export const DEFAULT_WEBGPU_ESTIMATED_MB = 40;
export const DEFAULT_WEBGPU_CACHE_MB = 256;
export const DEFAULT_WEBGPU_IDLE_UNLOAD_MS = 300_000;

export type WebGpuStatus =
  | "idle"
  | "probing"
  | "downloading"
  | "ready"
  | "blocked"
  | "unsupported"
  | "error";

export type WebGpuProgress = {
  loadedBytes: number;
  totalBytes: number;
  pct: number;
};

export type WebGpuProbe = {
  supported: boolean;
  reason?: "no-webgpu" | "no-adapter" | "no-storage" | "quota-exceeded";
  quotaMb?: number;
};

export type WebGpuEngine = {
  load(modelId: string, weights: Uint8Array): Promise<void>;
  partial?(utteranceId: number, pcm: Float32Array): Promise<string | null> | string | null;
  final(
    utteranceId: number,
    pcm: Float32Array,
  ): Promise<{ text: string; lang?: string; ms?: number }>;
  unload?(): Promise<void> | void;
};

export type OrtSessionLike = {
  inputNames?: readonly string[];
  outputNames?: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data?: unknown }>>;
  release?(): Promise<void> | void;
};

export type OrtLike = {
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(
      buffer: Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<OrtSessionLike>;
  };
};

/**
 * Real lazy-loaded WebGPU ONNX engine factory: imports `onnxruntime-web` only
 * when `load()` is first called, creates a WebGPU `InferenceSession` from the
 * cached model weights, and releases it on `unload()`.
 */
export function createDefaultWebGpuEngine(opts: {
  importOrt?: () => Promise<OrtLike>;
  decodeOutput?: (outputs: Record<string, { data?: unknown }>) => string;
} = {}): WebGpuEngine {
  const importOrt =
    opts.importOrt ?? (() => import("onnxruntime-web") as unknown as Promise<OrtLike>);
  let ort: OrtLike | null = null;
  let session: OrtSessionLike | null = null;

  return {
    async load(_modelId, weights) {
      ort ??= await importOrt();
      session = await ort.InferenceSession.create(weights, {
        executionProviders: ["webgpu"],
      });
    },
    async final(_utteranceId, pcm) {
      if (!ort || !session) throw new Error("webgpu-engine-not-loaded");
      const inputName = session.inputNames?.[0] ?? "input_features";
      const tensor = new ort.Tensor("float32", pcm, [1, pcm.length]);
      const outputs = await session.run({ [inputName]: tensor });
      if (opts.decodeOutput) return { text: opts.decodeOutput(outputs) };
      const firstKey = session.outputNames?.[0] ?? Object.keys(outputs)[0];
      const raw = firstKey ? outputs[firstKey]?.data : undefined;
      const text = typeof raw === "string" ? raw : "";
      return { text };
    },
    async unload() {
      const s = session;
      session = null;
      await s?.release?.();
    },
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WebGpuManagerDeps = {
  modelId?: string;
  modelUrl?: string;
  cacheMb?: number;
  idleUnloadMs?: number;
  estimatedMb?: number;
  probe?: () => Promise<WebGpuProbe>;
  fetch?: FetchLike;
  confirmDownload?: (details: {
    estimatedMb: number;
    risk: ModelDownloadRisk;
  }) => boolean | Promise<boolean>;
  network?: () => ModelNetwork;
  cache?: () => Promise<Pick<Cache, "match" | "put" | "delete">>;
  engine?: WebGpuEngine;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  onReadyEvent?: () => void;
};

export type WebGpuSnapshot = {
  status: WebGpuStatus;
  progress: WebGpuProgress;
  modelId: string;
  sizeLabel?: string;
  error?: string;
};

export function formatModelSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export async function defaultProbeWebGpu(minCacheMb = DEFAULT_WEBGPU_CACHE_MB): Promise<WebGpuProbe> {
  const nav = globalThis.navigator as
    | (Navigator & {
        gpu?: { requestAdapter?: () => Promise<unknown | null> };
        storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
      })
    | undefined;
  if (!nav?.gpu?.requestAdapter) return { supported: false, reason: "no-webgpu" };
  let adapter: unknown = null;
  try {
    adapter = await nav.gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) return { supported: false, reason: "no-adapter" };
  if (nav.storage?.estimate) {
    try {
      const est = await nav.storage.estimate();
      const freeMb =
        typeof est.quota === "number" && typeof est.usage === "number"
          ? Math.floor((est.quota - est.usage) / (1024 * 1024))
          : undefined;
      if (freeMb !== undefined && freeMb < minCacheMb) {
        return { supported: false, reason: "quota-exceeded", quotaMb: freeMb };
      }
      return { supported: true, ...(freeMb !== undefined ? { quotaMb: freeMb } : {}) };
    } catch {
      return { supported: true };
    }
  }
  return { supported: true };
}

function modelDownloadUrl(modelId: string, customUrl?: string): string {
  if (customUrl) return customUrl;
  if (modelId === DEFAULT_WEBGPU_MODEL_ID) return DEFAULT_WEBGPU_MODEL_URL;
  return `https://huggingface.co/${modelId}/resolve/main/onnx/encoder_model.onnx`;
}

export function createWebGpuModelManager(deps: WebGpuManagerDeps = {}) {
  const modelId = deps.modelId || DEFAULT_WEBGPU_MODEL_ID;
  const cacheMb = deps.cacheMb ?? DEFAULT_WEBGPU_CACHE_MB;
  const idleUnloadMs = deps.idleUnloadMs ?? DEFAULT_WEBGPU_IDLE_UNLOAD_MS;
  const engine = deps.engine ?? createDefaultWebGpuEngine();
  const f = deps.fetch ?? (globalThis.fetch as FetchLike | undefined);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let status: WebGpuStatus = "idle";
  let progress: WebGpuProgress = { loadedBytes: 0, totalBytes: 0, pct: 0 };
  let knownSizeBytes: number | undefined;
  let error: string | undefined;
  let loaded = false;
  let inFlight: Promise<boolean> | null = null;
  let abortCtrl: AbortController | null = null;
  let idleTimer: unknown = null;
  let activeUtts = 0;
  const subs = new Set<(snap: WebGpuSnapshot) => void>();

  const snapshot = (): WebGpuSnapshot => ({
    status,
    progress: { ...progress },
    modelId,
    ...(knownSizeBytes !== undefined ? { sizeLabel: formatModelSize(knownSizeBytes) } : {}),
    ...(error ? { error } : {}),
  });

  const emit = () => {
    const snap = snapshot();
    for (const fn of subs) fn(snap);
  };

  const resetIdleTimer = () => {
    if (idleTimer !== null) {
      clearTimer(idleTimer);
      idleTimer = null;
    }
    if (!loaded || activeUtts > 0 || idleUnloadMs <= 0) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (activeUtts > 0 || !loaded) return;
      loaded = false;
      status = "idle";
      void Promise.resolve(engine.unload?.()).catch(() => {});
      emit();
    }, idleUnloadMs);
  };

  async function estimateSize(): Promise<{ bytes: number | null; label: string; maxMb: number }> {
    if (knownSizeBytes !== undefined) {
      return { bytes: knownSizeBytes, label: formatModelSize(knownSizeBytes), maxMb: cacheMb };
    }
    if (f) {
      try {
        const head = await f(modelDownloadUrl(modelId, deps.modelUrl), { method: "HEAD" });
        const len = Number(head.headers.get("content-length") || "0");
        if (head.ok && Number.isFinite(len) && len > 0) {
          knownSizeBytes = len;
          emit();
          return { bytes: len, label: formatModelSize(len), maxMb: cacheMb };
        }
      } catch {}
    }
    return { bytes: null, label: `<= ${cacheMb} MB`, maxMb: cacheMb };
  }

  async function runEnsure(): Promise<boolean> {
    if (loaded && status === "ready") {
      resetIdleTimer();
      return true;
    }
    status = "probing";
    error = undefined;
    emit();

    const probe = await (deps.probe ? deps.probe() : defaultProbeWebGpu(cacheMb));
    if (!probe.supported) {
      status = "unsupported";
      error = probe.reason ?? "unsupported";
      emit();
      return false;
    }

    // Show size before first download via HEAD when available.
    const est = await estimateSize();
    const maxBytes = cacheMb * 1024 * 1024;
    if (est.bytes !== null && est.bytes > maxBytes) {
      status = "error";
      error = "model-exceeds-cache-limit";
      emit();
      return false;
    }
    const estimatedMb =
      est.bytes !== null
        ? Math.max(1, Math.ceil(est.bytes / (1024 * 1024)))
        : (deps.estimatedMb ?? Math.min(DEFAULT_WEBGPU_ESTIMATED_MB, cacheMb));

    status = "downloading";
    progress = { loadedBytes: 0, totalBytes: est.bytes ?? 0, pct: 0 };
    emit();

    abortCtrl = new AbortController();
    let weights: Uint8Array;
    try {
      const url = modelDownloadUrl(modelId, deps.modelUrl);
      const assets = await downloadModelAssets({
        assets: [{ url }],
        cacheName: WEBGPU_CACHE,
        estimatedMb,
        confirm: deps.confirmDownload,
        network: deps.network,
        cache: deps.cache,
        fetch: f as typeof fetch,
        signal: abortCtrl.signal,
      });
      weights = new Uint8Array(assets[0]!.bytes);
      if (weights.byteLength > maxBytes) throw new Error("model-exceeds-cache-limit");
      knownSizeBytes = weights.byteLength;
      progress = {
        loadedBytes: weights.byteLength,
        totalBytes: weights.byteLength,
        pct: 100,
      };
    } catch (e) {
      if (e instanceof ModelDownloadBlocked) {
        status = "blocked";
        error = "model-download-blocked";
        emit();
        return false;
      }
      if ((e as { name?: string })?.name === "AbortError") {
        status = "idle";
        progress = { loadedBytes: 0, totalBytes: 0, pct: 0 };
        emit();
        return false;
      }
      status = "error";
      error = String((e as Error)?.message ?? e).slice(0, 120);
      emit();
      return false;
    } finally {
      abortCtrl = null;
    }

    try {
      await engine.load(modelId, weights);
      loaded = true;
      status = "ready";
      emit();
      resetIdleTimer();
      if (deps.onReadyEvent) deps.onReadyEvent();
      else if (typeof window !== "undefined") window.dispatchEvent(new Event(WEBGPU_READY_EVENT));
      return true;
    } catch (e) {
      status = "error";
      error = String((e as Error)?.message ?? e).slice(0, 120);
      emit();
      return false;
    }
  }

  return {
    status: () => status,
    snapshot,
    engine: () => engine,
    modelId: () => modelId,
    estimateSize,
    ensureReady(): Promise<boolean> {
      if (loaded && status === "ready") {
        resetIdleTimer();
        return Promise.resolve(true);
      }
      if (!inFlight) {
        inFlight = runEnsure().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    cancelDownload() {
      abortCtrl?.abort();
    },
    touchUtterance(delta: 1 | -1) {
      activeUtts = Math.max(0, activeUtts + delta);
      resetIdleTimer();
    },
    subscribe(fn: (snap: WebGpuSnapshot) => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export type WebGpuModelManager = ReturnType<typeof createWebGpuModelManager>;

export type WebGpuConfig = {
  enabled: boolean;
  modelUrl?: string;
  cacheMb?: number;
  idleUnloadMs?: number;
};

let sharedManager: WebGpuModelManager | null = null;
let sharedKey = "";

export function getSharedWebGpuManager(
  conf?: Partial<WebGpuConfig> & Pick<WebGpuManagerDeps, "confirmDownload" | "engine">,
): WebGpuModelManager {
  const key = JSON.stringify({
    modelUrl: conf?.modelUrl,
    cacheMb: conf?.cacheMb,
    idleUnloadMs: conf?.idleUnloadMs,
  });
  if (!sharedManager || (conf && key !== sharedKey)) {
    sharedKey = key;
    sharedManager = createWebGpuModelManager({
      ...(conf?.modelUrl ? { modelUrl: conf.modelUrl } : {}),
      ...(conf?.cacheMb !== undefined ? { cacheMb: conf.cacheMb } : {}),
      ...(conf?.idleUnloadMs !== undefined ? { idleUnloadMs: conf.idleUnloadMs } : {}),
      ...(conf?.confirmDownload ? { confirmDownload: conf.confirmDownload } : {}),
      ...(conf?.engine ? { engine: conf.engine } : {}),
    });
  }
  return sharedManager;
}

function decodePcm16(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor((bytes.byteLength - 1) / 2);
  const out = new Float32Array(Math.max(0, sampleCount));
  const view = new DataView(bytes.buffer, bytes.byteOffset + 1, sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

/**
 * Wrap a `WebGpuModelManager` as a `WsLike` socket for `createLocalStt`'s race.
 * Audio stays on the device ONLY on this `webgpu:local` route; if the model is
 * not yet `ready` or blocked, this closes (`4010`) so server/cloud routes handle
 * the utterance as usual.
 */
export function openWebGpuStt(
  manager: WebGpuModelManager,
  opts: { now?: () => number } = {},
): WsLike {
  const now = opts.now ?? Date.now;
  const buffers = new Map<number, Float32Array[]>();
  let closed = false;

  const shim: WsLike = {
    readyState: 0,
    binaryType: "arraybuffer",
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send(data: string | Uint8Array) {
      if (closed || shim.readyState !== 1) return;
      if (typeof data === "string") {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const t = msg.t;
        const id = typeof msg.id === "number" ? msg.id : undefined;
        if (t === "begin" && id !== undefined) {
          buffers.set(id, []);
          manager.touchUtterance(1);
          return;
        }
        if (t === "cancel" && id !== undefined) {
          if (buffers.delete(id)) manager.touchUtterance(-1);
          return;
        }
        if (t === "end" && id !== undefined) {
          const parts = buffers.get(id) ?? [];
          buffers.delete(id);
          const total = parts.reduce((n, p) => n + p.length, 0);
          const full = new Float32Array(total);
          let off = 0;
          for (const p of parts) {
            full.set(p, off);
            off += p.length;
          }
          const eng = manager.engine();
          const t0 = now();
          void eng
            .final(id, full)
            .then((res) => {
              if (closed) return;
              shim.onmessage?.({
                data: JSON.stringify({
                  t: "final",
                  id,
                  text: res.text,
                  model: manager.modelId(),
                  ...(res.lang ? { lang: res.lang } : {}),
                  ms: res.ms ?? Math.max(0, Math.round(now() - t0)),
                  signals: { decoder: "whisper" },
                }),
              });
            })
            .catch((e) => {
              if (closed) return;
              shim.onmessage?.({
                data: JSON.stringify({
                  t: "error",
                  id,
                  error: String((e as Error)?.message ?? e).slice(0, 120),
                }),
              });
            })
            .finally(() => {
              manager.touchUtterance(-1);
            });
        }
        return;
      }

      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.byteLength < 2) return;
      const samples = decodePcm16(bytes);
      for (const [id, list] of buffers) {
        list.push(samples);
        const eng = manager.engine();
        if (eng?.partial) {
          void Promise.resolve(eng.partial(id, samples))
            .then((text) => {
              if (!closed && text) {
                shim.onmessage?.({ data: JSON.stringify({ t: "partial", id, text }) });
              }
            })
            .catch(() => {});
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      shim.readyState = 3;
      for (let i = 0; i < buffers.size; i++) manager.touchUtterance(-1);
      buffers.clear();
      shim.onclose?.({ code: 1000, reason: "closed", wasClean: true });
    },
  };

  queueMicrotask(() => {
    if (closed) return;
    if (manager.status() !== "ready") {
      if (manager.status() === "idle") void manager.ensureReady();
      closed = true;
      shim.readyState = 3;
      shim.onclose?.({ code: 4010, reason: `webgpu-${manager.status()}`, wasClean: false });
      return;
    }
    shim.readyState = 1;
    shim.onopen?.({});
    shim.onmessage?.({
      data: JSON.stringify({ t: "ready", model: manager.modelId() }),
    });
  });

  return shim;
}
