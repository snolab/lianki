import { getCloudflareContext } from "@opennextjs/cloudflare";
import { sessionTag } from "@/lib/dev-eval";

/**
 * A sign-in session was deleted (sign-out): tell lianki-push's DebugHub, over
 * the PUSH service binding, so every eval grant whose auto-renewal is bound to
 * that session stops renewing at once (docs/monitoring.md, "Renewal"). Only
 * the session's tag (a hash of its id) is sent. Off the Worker (dev, QA) there
 * is no binding: nothing happens. Never throws: a sign-out must not fail on it.
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

export async function notifySignedOut(sessionId: string, binding = push()): Promise<void> {
  if (!binding || !sessionId) return;
  try {
    const res = await binding.fetch("https://lianki-push/internal/signed-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: await sessionTag(sessionId) }),
    });
    if (!res.ok) console.error(`[debug] signed-out notice: lianki-push ${res.status}`);
  } catch (e) {
    console.error("[debug] signed-out notice:", e);
  }
}
