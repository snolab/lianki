/** Shared guard for browser model downloads. Network speed is not a billing signal. */
export type ModelConnection = {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
  metered?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};
export type ModelNetwork = { connection?: ModelConnection; online?: boolean };
export type ModelDownloadRisk = "restricted" | "unknown" | "unmetered";
export function modelDownloadRisk(n: ModelNetwork): ModelDownloadRisk {
  const c = n.connection;
  if (n.online === false || c?.saveData || c?.metered || c?.type === "cellular" || c?.type === "none") return "restricted";
  // effectiveType=4g can describe fast cellular; absence of Save-Data is not consent.
  return c?.type === "wifi" || c?.type === "ethernet" ? "unmetered" : "unknown";
}
export function browserModelNetwork(): ModelNetwork {
  const n = globalThis.navigator as Navigator & { connection?: ModelConnection; mozConnection?: ModelConnection; webkitConnection?: ModelConnection };
  return { connection: n?.connection ?? n?.mozConnection ?? n?.webkitConnection, online: n?.onLine };
}
const networkKey = (n: ModelNetwork) => JSON.stringify([n.online, n.connection?.type, n.connection?.saveData, n.connection?.metered, n.connection?.effectiveType]);
/** `bytes`: the exact size when known in advance (pinned files), so the confirm total needs no request. */
export type ModelAsset = { url: string; sha256?: string; bytes?: number };
export type ModelAssetBytes = { url: string; bytes: ArrayBuffer; downloaded?: boolean };
export class ModelDownloadBlocked extends Error {
  constructor() { super("model-download-blocked"); }
}

/**
 * Cancels (calls `onCancel`) when the page goes offline, or the connection
 * changes to anything but an unmetered one. Returns the function that stops
 * watching. Used for the download and for the load after it.
 */
export function watchModelNetwork(o: {
  network?: () => ModelNetwork;
  events?: Pick<Window, "addEventListener" | "removeEventListener">;
  onCancel: () => void;
}): () => void {
  const network = o.network ?? browserModelNetwork;
  const events = o.events ?? globalThis.window;
  const initial = network();
  const connection = initial.connection;
  const key = networkKey(initial);
  const cancel = () => o.onCancel();
  const changed = () => {
    const current = network();
    if (current.online === false || (modelDownloadRisk(current) !== "unmetered" && networkKey(current) !== key)) cancel();
  };
  connection?.addEventListener?.("change", changed);
  events?.addEventListener("offline", cancel);
  events?.addEventListener("online", changed);
  return () => {
    connection?.removeEventListener?.("change", changed);
    events?.removeEventListener("offline", cancel);
    events?.removeEventListener("online", changed);
  };
}

/**
 * All uncached model/runtime requests go through this boundary. Confirmation
 * is for this batch/network only, never a durable permission for future data use.
 * Callers provide the complete manifest and a truthful approximate total size.
 */
export async function downloadModelAssets(o: {
  assets: readonly ModelAsset[];
  cacheName: string;
  estimatedMb: number;
  confirm?: (details: {
    estimatedMb: number;
    risk: ModelDownloadRisk;
    signal?: AbortSignal;
  }) => boolean | Promise<boolean>;
  network?: () => ModelNetwork;
  cache?: () => Promise<Pick<Cache, "match" | "put" | "delete">>;
  fetch?: typeof fetch;
  events?: Pick<Window, "addEventListener" | "removeEventListener">;
  signal?: AbortSignal;
}): Promise<ModelAssetBytes[]> {
  const network = o.network ?? browserModelNetwork;
  const transport = o.fetch ?? globalThis.fetch;
  let cache: Awaited<ReturnType<NonNullable<typeof o.cache>>> | undefined;
  try { cache = await (o.cache?.() ?? caches.open(o.cacheName)); } catch {}
  const results: ModelAssetBytes[] = [];
  const missing: ModelAsset[] = [];
  const verify = async (asset: ModelAsset, bytes: ArrayBuffer) => {
    if (!asset.sha256) return true;
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    return hash === asset.sha256;
  };
  // Validate cached files too: an invalid file must not silently trigger a paid download.
  for (const asset of o.assets) {
    const response = await cache?.match(asset.url).catch(() => undefined);
    if (response?.ok) {
      const bytes = await response.arrayBuffer();
      if (await verify(asset, bytes)) { results.push({ url: asset.url, bytes }); continue; }
      await cache?.delete(asset.url).catch(() => {});
    }
    missing.push(asset);
  }
  if (!missing.length) return results;
  // Only what is missing is downloaded: when every missing file's size is known, that is the total.
  const known = missing.every((a) => typeof a.bytes === "number" && a.bytes > 0);
  const estimatedMb = known
    ? Math.max(1, Math.ceil(missing.reduce((n, a) => n + (a.bytes ?? 0), 0) / (1024 * 1024)))
    : o.estimatedMb;
  const controller = new AbortController();
  const events = o.events ?? globalThis.window;
  const initial = network();
  const connection = initial.connection;
  const key = networkKey(initial);
  const cancel = () => controller.abort(new ModelDownloadBlocked());
  const changed = () => {
    const current = network();
    if (current.online === false || (modelDownloadRisk(current) !== "unmetered" && networkKey(current) !== key)) cancel();
  };
  connection?.addEventListener?.("change", changed);
  events?.addEventListener("offline", cancel);
  events?.addEventListener("online", changed);
  o.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (o.signal?.aborted) cancel();
    if (initial.online === false) throw new ModelDownloadBlocked();
    if (!Number.isFinite(estimatedMb) || estimatedMb <= 0) throw new ModelDownloadBlocked();
    const risk = modelDownloadRisk(initial);
    if (risk !== "unmetered") {
      // No confirmation UI, a UI failure, or refusal: keep cloud STT, fetch nothing.
      let yes = false;
      try { yes = (await o.confirm?.({ estimatedMb, risk, signal: controller.signal })) === true; } catch {}
      if (!yes) throw new ModelDownloadBlocked();
    }
    changed();
    controller.signal.throwIfAborted();
    for (const asset of missing) {
      changed();
      controller.signal.throwIfAborted();
      const response = await transport(asset.url, { mode: "cors", credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error(`model-download-http-${response.status}`);
      const bytes = await response.arrayBuffer();
      changed();
      controller.signal.throwIfAborted();
      if (!(await verify(asset, bytes))) throw new Error("model-download-digest");
      await cache?.put(asset.url, new Response(bytes, { headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" } })).catch(() => {});
      results.push({ url: asset.url, bytes, downloaded: true });
    }
    controller.signal.throwIfAborted();
    return results;
  } finally {
    connection?.removeEventListener?.("change", changed);
    events?.removeEventListener("offline", cancel);
    events?.removeEventListener("online", changed);
    o.signal?.removeEventListener("abort", cancel);
  }
}
