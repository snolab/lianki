/**
 * The "Linky" spotter in the browser (docs/wake-word.md): sherpa-onnx's
 * keyword spotter compiled to WASM (@sherpaw/kws, Apache-2.0) with the
 * kws-zipformer-zh-en-3M-2025-12-20 model (Apache-2.0), in a Worker so it
 * never blocks the page.
 *
 * Loaded lazily, the first time the mic goes passive, never before: about
 * 12 MB of runtime from jsDelivr and 13 MB of model from Hugging Face, both
 * at pinned versions, each checked against its SHA-256 and kept in the Cache
 * API (WAKE_CACHE), so the next time it starts with no download. One
 * utterance (a VAD segment) is checked at a time, after it ends, so the
 * spotter costs nothing while the room is quiet.
 */
import { type Detection, LINKY, type SpotResult, afterKeyword } from "./wake";

/** The KWS runtime: its Emscripten glue and wasm (npm @sherpaw/kws, published 2026-10-12). */
export const KWS_BASE = "https://cdn.jsdelivr.net/npm/@sherpaw/kws@0.3.0/dist/";
export const KWS_GLUE = "wasm-CP0rq9dg.js";
/** The model pack, at a pinned Hugging Face commit (moeru-ai's unmodified upstream fp32 weights). */
export const KWS_MODEL =
  "https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/resolve/1770a4b22db32184c110ac43c601db17cc9c93f8/install/bin/wasm/";
/** SHA-256 of every file the Worker runs or reads; anything else is refused. */
export const KWS_SHA256: Record<string, string> = {
  [`${KWS_BASE}${KWS_GLUE}`]: "122c98b161abd39a6ff11dc6c5bfcb0ecbcd334ddb66e4e96065fb944bf05596",
  [`${KWS_BASE}prebuilt/kws.wasm`]:
    "b75814d1f900cc99efc7de51ae561ffb2517456307488ec4387689c953b9b983",
  [`${KWS_MODEL}preload.data`]: "4ca3ae0d147df1576fac87a4837f5a8959f4f87600a8306c57cc67eb8b40494d",
};
/** The Cache API cache; bump the version to drop an old download. */
export const WAKE_CACHE = "lk-wake-v1";
/** One utterance's check; past this the utterance is dropped as "no wake word". */
export const SPOT_TIMEOUT_MS = 8_000;
/**
 * The spotter's start (download, digest checks, WASM init); past this it is
 * "failed", so the mic goes back to active and no utterance waits on it. The
 * Worker keeps going: if it gets ready later, the next passive turn uses it
 * (a slow first download is not thrown away and started over).
 */
export const LOAD_TIMEOUT_MS = 15_000;
export const RATE = 16_000;
/** Silence appended so the spotter flushes a keyword at the very end of the segment. */
export const TAIL_PAD_S = 1;

/**
 * The Worker, as plain JS (a Blob URL, so it is same-origin). It fetches the
 * pinned files through the Cache API, verifies each digest, imports the glue
 * from a Blob (with its `import.meta.url` pointed back at jsDelivr, so it
 * finds its wasm there), writes the model into the WASM file system and
 * answers {type: "spot", id, samples} with {type: "spotted", id, hits, ms}.
 */
export const workerSource = (o: {
  base: string;
  glue: string;
  model: string;
  sha: Record<string, string>;
  cache: string;
}) => `
const O = ${JSON.stringify(o)};
const realFetch = self.fetch.bind(self);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function get(url) {
  let c = null;
  try { c = await caches.open(O.cache); } catch {}
  let res = c ? await c.match(url).catch(() => null) : null;
  let fresh = false;
  if (!res) { res = await realFetch(url, { mode: "cors", credentials: "omit" }); fresh = true; }
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const buf = await res.arrayBuffer();
  const want = O.sha[url];
  if (want) {
    const got = hex(await crypto.subtle.digest("SHA-256", buf));
    if (got !== want) { if (c) await c.delete(url).catch(() => {}); throw new Error("digest mismatch for " + url); }
  }
  if (fresh && c) await c.put(url, new Response(buf, { headers: { "content-type": res.headers.get("content-type") || "application/octet-stream" } })).catch(() => {});
  return { buf, fresh };
}
const wasmUrl = O.base + "prebuilt/kws.wasm";
self.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url !== wasmUrl) return realFetch(input, init);
  const { buf } = await get(url);
  return new Response(buf, { headers: { "content-type": "application/wasm" } });
};
let spotter = null;
async function init(keywords) {
  const t0 = performance.now();
  const glueUrl = O.base + O.glue;
  const [glue, data, meta] = await Promise.all([
    get(glueUrl),
    get(O.model + "preload.data"),
    get(O.model + "preload.js.metadata"),
  ]);
  const src = new TextDecoder().decode(glue.buf).split("import.meta.url").join(JSON.stringify(glueUrl));
  const blob = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const lib = await import(blob);
  URL.revokeObjectURL(blob);
  const mod = await lib.t();
  const bytes = new Uint8Array(data.buf);
  const files = JSON.parse(new TextDecoder().decode(meta.buf)).files;
  for (const f of files) mod.FS.writeFile(f.filename, bytes.subarray(f.start, f.end));
  spotter = lib.n(mod, {
    model: { encoder: "/encoder.onnx", decoder: "/decoder.onnx", joiner: "/joiner.onnx", tokens: "/tokens.txt" },
    keywords,
  });
  return { ms: Math.round(performance.now() - t0), downloaded: data.fresh };
}
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === "init") {
    try { postMessage({ type: "ready", ...(await init(m.keywords)) }); }
    catch (err) { postMessage({ type: "failed", error: String((err && err.message) || err) }); }
    return;
  }
  if (m.type === "spot") {
    const t0 = performance.now();
    try {
      spotter.reset();
      const hits = spotter.processAudio(m.samples, ${RATE});
      postMessage({ type: "spotted", id: m.id, hits, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      postMessage({ type: "spotted", id: m.id, hits: [], error: String((err && err.message) || err) });
    }
  }
};
`;

/** The segment as the spotter wants it: clamped to [-1, 1], with TAIL_PAD_S of silence after. */
export function padForSpot(audio: Float32Array): Float32Array {
  const out = new Float32Array(audio.length + Math.round(TAIL_PAD_S * RATE));
  for (let i = 0; i < audio.length; i++) {
    const s = audio[i];
    out[i] = s > 1 ? 1 : s < -1 ? -1 : Number.isFinite(s) ? s : 0;
  }
  return out;
}

/**
 * "needs-wifi": the files are not cached yet and the connection is cellular
 * or Save-Data (navigator.connection, where the browser has it): the ~25 MB
 * first download waits for Wi-Fi.
 */
export type KwsState = "idle" | "loading" | "ready" | "failed" | "needs-wifi";

/**
 * May the first download start now? Yes once the model is in the Cache API;
 * else no on a cellular or Save-Data connection. Browsers without
 * navigator.connection (Safari) are not asked: yes.
 */
export async function mayDownload(
  nav: { connection?: { type?: string; saveData?: boolean } } | undefined = globalThis.navigator as never,
  cached: () => Promise<boolean> = async () => {
    try {
      return !!(await (await caches.open(WAKE_CACHE)).match(`${KWS_MODEL}preload.data`));
    } catch {
      return false;
    }
  },
): Promise<boolean> {
  const c = nav?.connection;
  if (!c || (c.type !== "cellular" && !c.saveData)) return true;
  return cached();
}
/** The slice of a Worker the spotter uses (a fake in the tests). */
export type WorkerLike = {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type Kws = ReturnType<typeof createKws>;

/**
 * The spotter's page side: `load()` starts the Worker once (later calls share
 * it), `spot(audio)` checks one utterance. A failed load can be retried by
 * calling `load()` again. A load still going after `loadTimeoutMs` is
 * "failed" (`{ev: "wake-kws", error: "load-timeout"}`) and its waiters get
 * no hit; a retry waits on the same Worker again rather than a new one.
 */
export function createKws(o: {
  worker?: () => WorkerLike;
  log?: (ev: Record<string, unknown>) => void;
  onState?: (s: KwsState) => void;
  timeoutMs?: number;
  /** LOAD_TIMEOUT_MS, shorter in the tests. */
  loadTimeoutMs?: number;
  /** mayDownload, replaced in the tests. */
  allowed?: () => Promise<boolean>;
}) {
  const make =
    o.worker ??
    (() => {
      const url = URL.createObjectURL(
        new Blob(
          [
            workerSource({
              base: KWS_BASE,
              glue: KWS_GLUE,
              model: KWS_MODEL,
              sha: KWS_SHA256,
              cache: WAKE_CACHE,
            }),
          ],
          { type: "text/javascript" },
        ),
      );
      const w = new Worker(url, { type: "module", name: "lk-wake" });
      URL.revokeObjectURL(url);
      return w as unknown as WorkerLike;
    });
  let state: KwsState = "idle";
  let w: WorkerLike | null = null;
  let ready: Promise<void> | null = null;
  let seq = 0;
  const waiting = new Map<number, (r: { hits: Detection[]; ms?: number; error?: string }) => void>();
  const set = (s: KwsState) => {
    state = s;
    o.onState?.(s);
  };
  /** The Worker's start itself, with no time limit; `ready` is it raced against the load timeout. */
  let boot: Promise<void> | null = null;
  const load = () => {
    if (ready && (state === "ready" || state === "loading")) return ready;
    set("loading");
    const t0 = Date.now();
    const start = () =>
      new Promise<void>((resolve, reject) => {
      try {
        w = make();
      } catch (e) {
        set("failed");
        o.log?.({ ev: "wake-kws", ok: false, error: String((e as Error)?.message ?? e) });
        return reject(e);
      }
      const fail = (error: string) => {
        set("failed");
        o.log?.({ ev: "wake-kws", ok: false, error, ms: Date.now() - t0 });
        w?.terminate();
        w = null;
        for (const f of waiting.values()) f({ hits: [], error });
        waiting.clear();
        reject(new Error(error));
      };
      w.onerror = (e) => fail(String((e as { message?: string })?.message ?? "worker error"));
      w.onmessage = (e) => {
        const m = e.data as {
          type?: string;
          id?: number;
          hits?: Detection[];
          ms?: number;
          error?: string;
          downloaded?: boolean;
        };
        if (m.type === "ready") {
          // Also after a load timeout: the next passive turn finds it ready.
          ready = Promise.resolve();
          set("ready");
          o.log?.({ ev: "wake-kws", ok: true, ms: m.ms, downloaded: m.downloaded });
          resolve();
        } else if (m.type === "failed") fail(m.error ?? "failed");
        else if (m.type === "spotted" && typeof m.id === "number") {
          const f = waiting.get(m.id);
          waiting.delete(m.id);
          f?.({ hits: m.hits ?? [], ms: m.ms, error: m.error });
        }
      };
      w.postMessage({ type: "init", keywords: [LINKY] });
    });
    if (!boot) {
      const b = (o.allowed ?? mayDownload)()
        .catch(() => true)
        .then((ok) => {
          if (ok) return start();
          set("needs-wifi");
          o.log?.({ ev: "wake-kws", ok: false, error: "needs-wifi" });
          throw new Error("needs-wifi");
        });
      // A failed start is forgotten, so the next load() tries again from the top.
      b.catch(() => {
        if (boot === b) boot = null;
      });
      boot = b;
    }
    const b = boot;
    const p = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        if (state !== "loading") return;
        set("failed");
        o.log?.({ ev: "wake-kws", ok: false, error: "load-timeout", ms: Date.now() - t0 });
        reject(new Error("load-timeout"));
      }, o.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
      b.then(resolve, reject).finally(() => clearTimeout(t));
    });
    p.catch(() => {});
    ready = p;
    return p;
  };
  /** Check one utterance (16 kHz mono) for "Linky"; never throws (a failure is "no hit"). */
  async function spot(audio: Float32Array): Promise<SpotResult> {
    try {
      await load();
    } catch (e) {
      return { hit: false, error: String((e as Error)?.message ?? e), unchecked: true };
    }
    const id = ++seq;
    const samples = padForSpot(audio);
    const r = await new Promise<{ hits: Detection[]; ms?: number; error?: string }>((resolve) => {
      const t = setTimeout(() => {
        waiting.delete(id);
        resolve({ hits: [], error: "timeout" });
      }, o.timeoutMs ?? SPOT_TIMEOUT_MS);
      waiting.set(id, (x) => {
        clearTimeout(t);
        resolve(x);
      });
      w?.postMessage({ type: "spot", id, samples }, [samples.buffer]);
    });
    return { ...afterKeyword(audio, r.hits, RATE), ms: r.ms, error: r.error };
  }
  return {
    load,
    spot,
    state: () => state,
    dispose() {
      w?.terminate();
      w = null;
      ready = null;
      boot = null;
      set("idle");
    },
  };
}
