import { cfg } from "./config-store";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { HubWorkSnapshot } from "./hub-work";
export type HubDiagnostics = HubWorkSnapshot & { pendingPolishTimer: boolean; polishBusy: boolean };
/** One explicit read, never polling; local dev without PUSH returns unavailable. */
export async function hubDiagnostics(): Promise<HubDiagnostics | null> {
  try {
    const { env } = getCloudflareContext();
    const push = (
      env as unknown as { PUSH?: { fetch(url: string, init?: RequestInit): Promise<Response> } }
    ).PUSH;
    if (!push) return null;
    const response = await push.fetch("https://lianki-push/internal/hub-diagnostics", {
      signal: AbortSignal.timeout(await cfg("chat.hubRpcTimeoutMs")),
    });
    return response.ok ? ((await response.json()) as HubDiagnostics) : null;
  } catch {
    return null;
  }
}
