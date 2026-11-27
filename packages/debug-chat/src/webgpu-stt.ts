/**
 * Client-side WebGPU local speech-to-text (docs/local-stt.md, /stt/windows-webgpu):
 * - Probes WebGPU (`navigator.gpu.requestAdapter`) and storage quota.
 * - Estimates total model manifest size first (`HEAD`), then routes uncached
 *   downloads through `downloadModelAssets` (`model-download.ts`) for
 *   metered/unknown-network confirmation and network-change cancellation.
 * - Runs the full Whisper pipeline locally on WebGPU: 80-bin log-Mel feature
 *   extraction -> ONNX encoder -> greedy autoregressive ONNX decoder -> BPE token
 *   decoding.
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
export const DEFAULT_WEBGPU_MODEL_ID =
  "onnx-community/whisper-tiny@ff4177021cc41f7db950912b73ea4fdf7d01d8e7";
export const DEFAULT_WEBGPU_MODEL_URL =
  "https://huggingface.co/onnx-community/whisper-tiny/resolve/ff4177021cc41f7db950912b73ea4fdf7d01d8e7";
export const DEFAULT_WEBGPU_ESTIMATED_MB = 44;
export const DEFAULT_WEBGPU_CACHE_MB = 256;
export const DEFAULT_WEBGPU_IDLE_UNLOAD_MS = 300_000;
/**
 * Where onnxruntime-web fetches its wasm runtime (`ort.env.wasm.wasmPaths`): a
 * CDN pinned to the exact installed version (package.json). The ~26 MiB
 * `ort-wasm-simd-threaded.jsep.wasm` is over the Workers 25 MiB per-asset
 * limit, so it must never be emitted into the Next build (next.config.mjs
 * aliases `onnxruntime-web/webgpu` to the build without the bundled wasm).
 * Live value: cfg("stt.webgpuOrtWasmBase").
 */
export const DEFAULT_WEBGPU_ORT_WASM_BASE =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

export const WHISPER_ASSET_PATHS = [
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
  "tokenizer.json",
  "config.json",
] as const;

export const WHISPER_N_FFT = 400;
export const WHISPER_HOP = 160;
export const WHISPER_N_MELS = 80;
export const WHISPER_MAX_FRAMES = 3000;
export const WHISPER_SAMPLE_RATE = 16_000;

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

export type WhisperModelBundle = {
  encoder: Uint8Array;
  decoder: Uint8Array;
  tokenizerJson?: Uint8Array;
  configJson?: Uint8Array;
};

export type WebGpuEngine = {
  load(modelId: string, bundle: WhisperModelBundle | Uint8Array): Promise<void>;
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
  run(feeds: Record<string, unknown>): Promise<Record<string, { data?: unknown; dims?: readonly number[] }>>;
  release?(): Promise<void> | void;
};

export type OrtLike = {
  env?: { wasm?: { wasmPaths?: unknown } };
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array | Uint8Array | boolean[],
    dims: number[],
  ) => unknown;
  InferenceSession: {
    create(
      buffer: Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<OrtSessionLike>;
  };
};

// ── Whisper Feature Extraction (Slaney 80-bin log-Mel, 30 s / 480,000 samples) ──

const SLANEY_F_SP = 200.0 / 3;
const SLANEY_MIN_LOG_HZ = 1000.0;
const SLANEY_MIN_LOG_MEL = SLANEY_MIN_LOG_HZ / SLANEY_F_SP;
const SLANEY_LOGSTEP = Math.log(6.4) / 27.0;

function hzToMelSlaney(hz: number): number {
  return hz >= SLANEY_MIN_LOG_HZ
    ? SLANEY_MIN_LOG_MEL + Math.log(hz / SLANEY_MIN_LOG_HZ) / SLANEY_LOGSTEP
    : hz / SLANEY_F_SP;
}

function melToHzSlaney(mel: number): number {
  return mel >= SLANEY_MIN_LOG_MEL
    ? SLANEY_MIN_LOG_HZ * Math.exp(SLANEY_LOGSTEP * (mel - SLANEY_MIN_LOG_MEL))
    : mel * SLANEY_F_SP;
}

let cachedMelBank: Float32Array[] | null = null;
function getMelFilterBank(): Float32Array[] {
  if (cachedMelBank) return cachedMelBank;
  const nFreqs = Math.floor(WHISPER_N_FFT / 2) + 1;
  const melMin = hzToMelSlaney(0);
  const melMax = hzToMelSlaney(WHISPER_SAMPLE_RATE / 2);
  const melPoints = new Float64Array(WHISPER_N_MELS + 2);
  for (let i = 0; i < melPoints.length; i++) {
    melPoints[i] = melToHzSlaney(melMin + ((melMax - melMin) * i) / (WHISPER_N_MELS + 1));
  }
  const bank: Float32Array[] = [];
  for (let m = 0; m < WHISPER_N_MELS; m++) {
    const fLeft = melPoints[m]!;
    const fCenter = melPoints[m + 1]!;
    const fRight = melPoints[m + 2]!;
    const enorm = fRight > fLeft ? 2.0 / (fRight - fLeft) : 0;
    const row = new Float32Array(nFreqs);
    for (let k = 0; k < nFreqs; k++) {
      const freq = (k * WHISPER_SAMPLE_RATE) / WHISPER_N_FFT;
      if (freq >= fLeft && freq <= fCenter && fCenter > fLeft) {
        row[k] = ((freq - fLeft) / (fCenter - fLeft)) * enorm;
      } else if (freq > fCenter && freq <= fRight && fRight > fCenter) {
        row[k] = ((fRight - freq) / (fRight - fCenter)) * enorm;
      }
    }
    bank.push(row);
  }
  cachedMelBank = bank;
  return bank;
}

let cachedHann: Float32Array | null = null;
function getHannWindow(): Float32Array {
  if (cachedHann) return cachedHann;
  const w = new Float32Array(WHISPER_N_FFT);
  for (let i = 0; i < WHISPER_N_FFT; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / WHISPER_N_FFT));
  }
  cachedHann = w;
  return w;
}

let cachedDft: { cos: Float32Array; sin: Float32Array } | null = null;
function getDftTables(): { cos: Float32Array; sin: Float32Array } {
  if (cachedDft) return cachedDft;
  const nFreqs = Math.floor(WHISPER_N_FFT / 2) + 1;
  const cos = new Float32Array(nFreqs * WHISPER_N_FFT);
  const sin = new Float32Array(nFreqs * WHISPER_N_FFT);
  for (let k = 0; k < nFreqs; k++) {
    const angleStep = (-2 * Math.PI * k) / WHISPER_N_FFT;
    const base = k * WHISPER_N_FFT;
    for (let n = 0; n < WHISPER_N_FFT; n++) {
      const a = angleStep * n;
      cos[base + n] = Math.cos(a);
      sin[base + n] = Math.sin(a);
    }
  }
  cachedDft = { cos, sin };
  return cachedDft;
}

/**
 * Compute Whisper-compatible 80-bin log-Mel spectrogram `[1, 80, frames]`.
 * Pads or trims `pcm` to `frames * 160` samples (`480,000` samples = 30 s at
 * default `frames = 3000`), applies center-padded STFT (`n_fft = 400`,
 * `hop = 160`, Hann window), Slaney mel filterbank, `log10` clamped at
 * `max - 8.0`, and `(x + 4.0) / 4.0` normalization.
 */
export function extractWhisperFeatures(
  pcm: Float32Array,
  frames = WHISPER_MAX_FRAMES,
): { data: Float32Array; dims: [number, number, number] } {
  const targetSamples = frames * WHISPER_HOP;
  const halfFft = WHISPER_N_FFT >> 1;
  const win = getHannWindow();
  const bank = getMelFilterBank();
  const { cos, sin } = getDftTables();
  const nFreqs = Math.floor(WHISPER_N_FFT / 2) + 1;
  const out = new Float32Array(WHISPER_N_MELS * frames);
  const spec = new Float32Array(nFreqs);
  const windowed = new Float32Array(WHISPER_N_FFT);
  const nonZeroLimit = Math.min(pcm.length, targetSamples);

  let maxVal = -Infinity;
  for (let f = 0; f < frames; f++) {
    const center = f * WHISPER_HOP;
    const start = center - halfFft;
    if (start >= nonZeroLimit) {
      for (let m = 0; m < WHISPER_N_MELS; m++) out[m * frames + f] = -10.0;
      if (-10.0 > maxVal) maxVal = -10.0;
      continue;
    }
    let anyNonZero = false;
    for (let n = 0; n < WHISPER_N_FFT; n++) {
      let idx = start + n;
      if (idx < 0) idx = -idx;
      else if (idx >= targetSamples) idx = 2 * targetSamples - 2 - idx;
      const s = idx >= 0 && idx < nonZeroLimit ? pcm[idx]! : 0;
      if (s !== 0) anyNonZero = true;
      windowed[n] = s * win[n]!;
    }
    if (!anyNonZero) {
      for (let m = 0; m < WHISPER_N_MELS; m++) out[m * frames + f] = -10.0;
      if (-10.0 > maxVal) maxVal = -10.0;
      continue;
    }
    for (let k = 0; k < nFreqs; k++) {
      let re = 0;
      let im = 0;
      const base = k * WHISPER_N_FFT;
      for (let n = 0; n < WHISPER_N_FFT; n++) {
        const w = windowed[n]!;
        re += w * cos[base + n]!;
        im += w * sin[base + n]!;
      }
      spec[k] = re * re + im * im;
    }
    for (let m = 0; m < WHISPER_N_MELS; m++) {
      const filt = bank[m]!;
      let energy = 0;
      for (let k = 0; k < nFreqs; k++) energy += spec[k]! * filt[k]!;
      const logE = Math.log10(Math.max(energy, 1e-10));
      out[m * frames + f] = logE;
      if (logE > maxVal) maxVal = logE;
    }
  }
  const floor = maxVal > -Infinity ? maxVal - 8.0 : -10.0;
  for (let i = 0; i < out.length; i++) {
    const clamped = out[i]! < floor ? floor : out[i]!;
    out[i] = (clamped + 4.0) / 4.0;
  }
  return { data: out, dims: [1, WHISPER_N_MELS, frames] };
}

// ── Whisper Tokenizer & Decoding ─────────────────────────────────────────────

export type WhisperTokenizer = {
  idToToken: Map<number, string>;
  specialIds: Set<number>;
  sotId: number;
  eosId: number;
  transcribeId: number;
  noTimestampsId: number;
};

function buildGpt2ByteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const map = new Map<string, number>();
  for (let i = 0; i < bs.length; i++) {
    map.set(String.fromCharCode(cs[i]!), bs[i]!);
  }
  return map;
}

const GPT2_BYTE_DECODER = buildGpt2ByteDecoder();

export function parseWhisperTokenizer(
  tokenizerBytes?: Uint8Array,
  configBytes?: Uint8Array,
): WhisperTokenizer {
  const idToToken = new Map<number, string>();
  const specialIds = new Set<number>();
  let sotId = 50258;
  let eosId = 50257;
  let transcribeId = 50359;
  let noTimestampsId = 50363;

  if (configBytes?.byteLength) {
    try {
      const cfg = JSON.parse(new TextDecoder().decode(configBytes)) as Record<string, unknown>;
      if (typeof cfg.decoder_start_token_id === "number") sotId = cfg.decoder_start_token_id;
      if (typeof cfg.eos_token_id === "number") eosId = cfg.eos_token_id;
    } catch {}
  }

  if (tokenizerBytes?.byteLength) {
    try {
      const tok = JSON.parse(new TextDecoder().decode(tokenizerBytes)) as {
        model?: { vocab?: Record<string, number> };
        added_tokens?: { id: number; content: string; special?: boolean }[];
      };
      for (const [piece, id] of Object.entries(tok.model?.vocab ?? {})) {
        idToToken.set(id, piece);
      }
      for (const added of tok.added_tokens ?? []) {
        idToToken.set(added.id, added.content);
        if (added.special || added.content.startsWith("<|")) specialIds.add(added.id);
        if (added.content === "<|startoftranscript|>") sotId = added.id;
        if (added.content === "<|endoftext|>") eosId = added.id;
        if (added.content === "<|transcribe|>") transcribeId = added.id;
        if (added.content === "<|notimestamps|>") noTimestampsId = added.id;
      }
    } catch {}
  }

  specialIds.add(sotId);
  specialIds.add(eosId);
  specialIds.add(transcribeId);
  specialIds.add(noTimestampsId);

  return { idToToken, specialIds, sotId, eosId, transcribeId, noTimestampsId };
}

export function decodeWhisperTokens(ids: readonly number[], tok: WhisperTokenizer): string {
  const bytes: number[] = [];
  for (const id of ids) {
    if (tok.specialIds.has(id)) continue;
    const piece = tok.idToToken.get(id);
    if (!piece || (piece.startsWith("<|") && piece.endsWith("|>"))) continue;
    for (const ch of piece) {
      const b = GPT2_BYTE_DECODER.get(ch);
      if (b !== undefined) bytes.push(b);
      else for (const utf8Byte of new TextEncoder().encode(ch)) bytes.push(utf8Byte);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).trim();
}

function argmaxLastStep(
  logitsData: ArrayLike<number>,
  dims: readonly number[] | undefined,
  stepLen: number,
): number {
  const vocabSize =
    dims && dims.length >= 2 ? dims[dims.length - 1]! : Math.floor(logitsData.length / Math.max(1, stepLen));
  const offset = Math.max(0, logitsData.length - vocabSize);
  let bestId = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < vocabSize; i++) {
    const score = Number(logitsData[offset + i]);
    if (score > bestScore) {
      bestScore = score;
      bestId = i;
    }
  }
  return bestId;
}

/**
 * Real lazy-loaded Whisper WebGPU ONNX engine factory: imports `onnxruntime-web`
 * only when `load()` is first called, creates WebGPU `InferenceSession`s for
 * both the Whisper encoder and decoder, runs feature extraction + encoder +
 * greedy autoregressive decoder + BPE token decoding, and releases sessions on
 * `unload()`.
 */
export function createDefaultWebGpuEngine(opts: {
  importOrt?: () => Promise<OrtLike>;
  /** Base URL of the ORT wasm files (`ort.env.wasm.wasmPaths`). */
  ortWasmBase?: string;
  maxTokens?: number;
  melFrames?: number;
} = {}): WebGpuEngine {
  const importOrt =
    opts.importOrt ?? (() => import("onnxruntime-web/webgpu") as unknown as Promise<OrtLike>);
  const ortWasmBase = opts.ortWasmBase || DEFAULT_WEBGPU_ORT_WASM_BASE;
  const maxTokens = opts.maxTokens ?? 128;
  const melFrames = opts.melFrames ?? WHISPER_MAX_FRAMES;

  let ort: OrtLike | null = null;
  let encoderSession: OrtSessionLike | null = null;
  let decoderSession: OrtSessionLike | null = null;
  let tokenizer: WhisperTokenizer | null = null;
  let numHeads = 6;
  let headDim = 64;

  return {
    async load(_modelId, input) {
      if (!ort) {
        ort = await importOrt();
        if (ort.env?.wasm) ort.env.wasm.wasmPaths = ortWasmBase;
      }
      const bundle: WhisperModelBundle =
        input instanceof Uint8Array ? { encoder: input, decoder: input } : input;
      tokenizer = parseWhisperTokenizer(bundle.tokenizerJson, bundle.configJson);
      if (bundle.configJson?.byteLength) {
        try {
          const cfg = JSON.parse(new TextDecoder().decode(bundle.configJson)) as {
            decoder_attention_heads?: number;
            d_model?: number;
          };
          if (typeof cfg.decoder_attention_heads === "number" && cfg.decoder_attention_heads > 0) {
            numHeads = cfg.decoder_attention_heads;
          }
          if (typeof cfg.d_model === "number" && numHeads > 0) {
            headDim = Math.floor(cfg.d_model / numHeads);
          }
        } catch {}
      }
      encoderSession = await ort.InferenceSession.create(bundle.encoder, {
        executionProviders: ["webgpu"],
      });
      decoderSession = await ort.InferenceSession.create(bundle.decoder, {
        executionProviders: ["webgpu"],
      });
    },
    async final(_utteranceId, pcm) {
      if (!ort || !encoderSession || !decoderSession || !tokenizer) {
        throw new Error("webgpu-engine-not-loaded");
      }
      const mel = extractWhisperFeatures(pcm, melFrames);
      const melInput = encoderSession.inputNames?.[0] ?? "input_features";
      const melTensor = new ort.Tensor("float32", mel.data, mel.dims);
      const encOut = await encoderSession.run({ [melInput]: melTensor });
      const encKey = encoderSession.outputNames?.[0] ?? Object.keys(encOut)[0] ?? "last_hidden_state";
      const encoderHiddenStates = encOut[encKey];
      const hiddenDims = encoderHiddenStates?.dims ? [...encoderHiddenStates.dims] : [1, melFrames / 2, 384];
      const hiddenTensor = new ort.Tensor(
        "float32",
        (encoderHiddenStates?.data as Float32Array) ?? new Float32Array(0),
        hiddenDims,
      );

      const decInputNames = decoderSession.inputNames ?? ["input_ids", "encoder_hidden_states"];
      const ids = [tokenizer.sotId, tokenizer.transcribeId, tokenizer.noTimestampsId];
      let pastKv = new Map<string, unknown>();

      for (let step = 0; step < maxTokens; step++) {
        const useCache = step > 0;
        const stepIds = useCache ? [ids[ids.length - 1]!] : ids;
        const feeds: Record<string, unknown> = {};
        for (const name of decInputNames) {
          if (name === "input_ids") {
            feeds[name] = new ort.Tensor(
              "int64",
              BigInt64Array.from(stepIds.map((id) => BigInt(id))),
              [1, stepIds.length],
            );
          } else if (name === "encoder_hidden_states") {
            feeds[name] = hiddenTensor;
          } else if (name === "use_cache_branch") {
            feeds[name] = new ort.Tensor("bool", [useCache], [1]);
          } else if (name.startsWith("past_key_values.")) {
            const existing = pastKv.get(name);
            feeds[name] =
              existing ?? new ort.Tensor("float32", new Float32Array(0), [1, numHeads, 0, headDim]);
          }
        }
        const decOut = await decoderSession.run(feeds);
        const nextKv = new Map<string, unknown>();
        for (const [outName, val] of Object.entries(decOut)) {
          if (outName.startsWith("present.")) {
            const pastName = `past_key_values.${outName.slice("present.".length)}`;
            if (useCache && outName.includes(".encoder.") && pastKv.has(pastName)) {
              nextKv.set(pastName, pastKv.get(pastName));
              continue;
            }
            nextKv.set(
              pastName,
              new ort.Tensor(
                "float32",
                (val.data as Float32Array) ?? new Float32Array(0),
                val.dims ? [...val.dims] : [1, numHeads, step + 1, headDim],
              ),
            );
          }
        }
        pastKv = nextKv;

        const logitsKey = decoderSession.outputNames?.[0] ?? Object.keys(decOut)[0] ?? "logits";
        const logits = decOut[logitsKey];
        const nextId = logits?.data
          ? argmaxLastStep(logits.data as ArrayLike<number>, logits.dims, stepIds.length)
          : tokenizer.eosId;
        if (nextId === tokenizer.eosId) break;
        ids.push(nextId);
      }
      return { text: decodeWhisperTokens(ids, tokenizer) };
    },
    async unload() {
      const enc = encoderSession;
      const dec = decoderSession;
      encoderSession = null;
      decoderSession = null;
      await Promise.all([enc?.release?.(), dec?.release?.()]);
    },
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WebGpuManagerDeps = {
  modelId?: string;
  modelUrl?: string;
  cacheMb?: number;
  idleUnloadMs?: number;
  /** Base URL of the ORT wasm files for the default engine. */
  ortWasmBase?: string;
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

export function modelAssetUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith(".onnx")) return [base];
  return WHISPER_ASSET_PATHS.map((p) => `${base}/${p}`);
}

export function createWebGpuModelManager(deps: WebGpuManagerDeps = {}) {
  const modelId = deps.modelId || DEFAULT_WEBGPU_MODEL_ID;
  const baseUrl = deps.modelUrl || DEFAULT_WEBGPU_MODEL_URL;
  const assetUrls = modelAssetUrls(baseUrl);
  const cacheMb = deps.cacheMb ?? DEFAULT_WEBGPU_CACHE_MB;
  const idleUnloadMs = deps.idleUnloadMs ?? DEFAULT_WEBGPU_IDLE_UNLOAD_MS;
  const engine =
    deps.engine ??
    createDefaultWebGpuEngine(deps.ortWasmBase ? { ortWasmBase: deps.ortWasmBase } : {});
  const f = deps.fetch ?? (globalThis.fetch as FetchLike | undefined);
  let confirmDownload = deps.confirmDownload;
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
        const heads = await Promise.all(
          assetUrls.map((u) => f(u, { method: "HEAD" }).catch(() => null)),
        );
        let sum = 0;
        let sawAny = false;
        for (const h of heads) {
          const len = h?.ok ? Number(h.headers.get("content-length") || "0") : 0;
          if (Number.isFinite(len) && len > 0) {
            sum += len;
            sawAny = true;
          }
        }
        if (sawAny) {
          knownSizeBytes = sum;
          emit();
          return { bytes: sum, label: formatModelSize(sum), maxMb: cacheMb };
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
    let bundle: WhisperModelBundle;
    try {
      const assets = await downloadModelAssets({
        assets: assetUrls.map((url) => ({ url })),
        cacheName: WEBGPU_CACHE,
        estimatedMb,
        confirm: confirmDownload,
        network: deps.network,
        cache: deps.cache,
        fetch: f as typeof fetch,
        signal: abortCtrl.signal,
      });
      const totalBytes = assets.reduce((sum, a) => sum + a.bytes.byteLength, 0);
      if (totalBytes > maxBytes) throw new Error("model-exceeds-cache-limit");
      knownSizeBytes = totalBytes;
      progress = { loadedBytes: totalBytes, totalBytes, pct: 100 };
      const byUrl = new Map(assets.map((a) => [a.url, new Uint8Array(a.bytes)]));
      if (assetUrls.length === 1) {
        const single = byUrl.get(assetUrls[0]!)!;
        bundle = { encoder: single, decoder: single };
      } else {
        bundle = {
          encoder: byUrl.get(assetUrls[0]!)!,
          decoder: byUrl.get(assetUrls[1]!)!,
          tokenizerJson: byUrl.get(assetUrls[2]!),
          configJson: byUrl.get(assetUrls[3]!),
        };
      }
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
      await engine.load(modelId, bundle);
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
    setConfirmDownload(fn: WebGpuManagerDeps["confirmDownload"]) {
      confirmDownload = fn;
    },
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
  ortWasmBase?: string;
};

let sharedManager: WebGpuModelManager | null = null;
let sharedKey = "";
let sharedConf: Partial<WebGpuConfig> = {};

export function getSharedWebGpuManager(
  conf?: Partial<WebGpuConfig> & Pick<WebGpuManagerDeps, "confirmDownload" | "engine">,
): WebGpuModelManager {
  const nextConf: Partial<WebGpuConfig> = {
    modelUrl: conf?.modelUrl !== undefined ? conf.modelUrl : sharedConf.modelUrl,
    cacheMb: conf?.cacheMb !== undefined ? conf.cacheMb : sharedConf.cacheMb,
    idleUnloadMs: conf?.idleUnloadMs !== undefined ? conf.idleUnloadMs : sharedConf.idleUnloadMs,
    ortWasmBase: conf?.ortWasmBase !== undefined ? conf.ortWasmBase : sharedConf.ortWasmBase,
  };
  const key = JSON.stringify(nextConf);
  if (!sharedManager || key !== sharedKey || conf?.engine) {
    sharedConf = nextConf;
    sharedKey = key;
    sharedManager = createWebGpuModelManager({
      ...(nextConf.modelUrl ? { modelUrl: nextConf.modelUrl } : {}),
      ...(nextConf.cacheMb !== undefined ? { cacheMb: nextConf.cacheMb } : {}),
      ...(nextConf.idleUnloadMs !== undefined ? { idleUnloadMs: nextConf.idleUnloadMs } : {}),
      ...(nextConf.ortWasmBase ? { ortWasmBase: nextConf.ortWasmBase } : {}),
      ...(conf?.confirmDownload ? { confirmDownload: conf.confirmDownload } : {}),
      ...(conf?.engine ? { engine: conf.engine } : {}),
    });
  } else if (conf?.confirmDownload) {
    sharedManager.setConfirmDownload(conf.confirmDownload);
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
