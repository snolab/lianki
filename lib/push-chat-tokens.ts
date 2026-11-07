import { getCloudflareContext } from "@opennextjs/cloudflare";
import { tagOf } from "@/lib/api-tokens";

/**
 * API tokens were revoked (one, or all of an account's): tell lianki-push's
 * DebugHub over the PUSH service binding, so a `lianki chat listen` socket
 * opened with one closes at once (POST /internal/chat-tokens/revoked
 * {tags?, userId?}, answered only on the binding's hostname). Only the tags
 * (16 hex of the token's hash) go, never a token.
 *
 * Best effort and never throws: every say/ask/read checks the token in D1
 * anyway, and the hub re-checks a listening token every few minutes
 * (debug.ts, "Token chat"). Off the Worker (dev, QA) there is no binding.
 */
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

function push(): Fetcher | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
  } catch {
    return null;
  }
}

export async function notifyTokensRevoked(
  r: { ids?: string[]; userId?: string },
  p: Fetcher | null = push(),
): Promise<void> {
  if (!p) return;
  try {
    const res = await p.fetch("https://lianki-push/internal/chat-tokens/revoked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(r.ids?.length ? { tags: r.ids.map(tagOf) } : {}),
        ...(r.userId ? { userId: r.userId } : {}),
      }),
    });
    if (!res.ok) console.error(`[api-tokens] revoke notice: lianki-push ${res.status}`);
  } catch (e) {
    console.error("[api-tokens] revoke notice:", String(e).slice(0, 200));
  }
}
