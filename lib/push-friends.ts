import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ChatMessage, FriendRecord } from "@/lib/dev-eval";

/**
 * The owner's side of the debug chat's friends list, held by lianki-push's
 * DebugHub and reached over the PUSH service binding (/internal/friends,
 * answered only on the binding's own hostname). Off the Worker (dev, QA)
 * there is no binding: every call answers null.
 */
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
export type Friend = { userId: string } & FriendRecord;

function push(): Fetcher | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
  } catch {
    return null;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  const p = push();
  if (!p) return null;
  const res = await p.fetch(`https://lianki-push/internal/friends${path}`, init);
  if (!res.ok) throw new Error(`lianki-push ${path || "/"}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const listFriends = async () => (await call<{ friends: Friend[] }>(""))?.friends ?? null;

export const friendThread = async (userId: string) =>
  (await call<{ messages: ChatMessage[] }>(`/thread?user=${encodeURIComponent(userId)}`))
    ?.messages ?? null;

export const setBlocked = (userId: string, blocked: boolean) =>
  call<{ ok: true; friend: Friend }>("", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, action: blocked ? "block" : "unblock" }),
  });
