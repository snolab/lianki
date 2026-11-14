import { HUB_RPC_LIMITS } from "./hub-rpc-config";
import { SESSION_METHODS, type SessionMethod } from "./sessions-http";
import type { HubWork } from "./hub-work";
const KEYS = [
  "chat.hubRpcTimeoutMs",
  "chat.polishRpcTimeoutMs",
  "chat.partnerRpcTimeoutMs",
] as const;
type Key = (typeof KEYS)[number];
type FetchBinding = { fetch(request: Request): Promise<Response> };

/** Race observes the abort even for test doubles; the actual binding fetch receives it too. */
export async function untilAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([run(), cancelled]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

/** All hub service calls have one deadline and diagnostics; no idle polling. */
export function boundedSessions<T extends object>(
  source: T,
  work: HubWork,
  now = Date.now,
  timeout = AbortSignal.timeout.bind(AbortSignal),
): T {
  const raw = source as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const binding = source as Partial<FetchBinding>;
  const values = Object.fromEntries(
    KEYS.map((key) => [key, HUB_RPC_LIMITS[key].default]),
  ) as Record<Key, number>;
  let readAt = -Infinity;
  let loading: Promise<void> | undefined;
  const invoke = (method: SessionMethod, args: unknown[], ms: number) =>
    work.run(method, async () => {
      const signal = timeout(ms);
      return untilAbort(signal, async () => {
        if (typeof binding.fetch !== "function") return raw[method]!(...args);
        const response = await binding.fetch(
          new Request("https://sessions/internal/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ method, args }),
            signal,
          }),
        );
        if (!response.ok) throw Error(`sessions ${method}: ${response.status}`);
        return ((await response.json()) as { value?: unknown }).value;
      });
    });
  const refresh = async () => {
    if (typeof binding.fetch !== "function" || now() - readAt < 60_000) return;
    loading ??= (async () => {
      readAt = now();
      await Promise.all(
        KEYS.map(async (key) => {
          try {
            const value = await invoke("config", [key], values["chat.hubRpcTimeoutMs"]);
            const bounds = HUB_RPC_LIMITS[key];
            if (
              typeof value === "number" &&
              Number.isInteger(value) &&
              value >= bounds.min &&
              value <= bounds.max
            )
              values[key] = value;
          } catch {
            /* Defaults/last good value after the bounded config read fails. */
          }
        }),
      );
    })().finally(() => {
      loading = undefined;
    });
    await loading;
  };
  return Object.fromEntries(
    SESSION_METHODS.filter((method) => typeof raw[method] === "function").map((method) => [
      method,
      async (...args: unknown[]) => {
        if (method !== "config") await refresh();
        const key: Key =
          method === "polishLines"
            ? "chat.polishRpcTimeoutMs"
            : method === "partnerReply" || method === "prepareChatTurn"
              ? "chat.partnerRpcTimeoutMs"
              : "chat.hubRpcTimeoutMs";
        return invoke(method, args, values[key]);
      },
    ]),
  ) as T;
}
