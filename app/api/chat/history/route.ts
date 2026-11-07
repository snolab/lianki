import { getCloudflareContext } from "@opennextjs/cloudflare";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import type { ChatLogDb } from "@/lib/chat-log";
import type { D1Like } from "@/lib/d1/types";
import { checkToken } from "@/lib/api-tokens";
import { type HistoryDeps, deleteHistory, getHistory } from "@/lib/chat-history-api";

/**
 * The signed-in user's chat history (lib/chat-history-api.ts;
 * docs/chat-history.md). 404 for no session, and for any line that is not
 * the caller's own.
 */
export const dynamic = "force-dynamic";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** lianki-push over the PUSH binding (lib/push-friends.ts); null off the Worker. */
function push(): Fetcher | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
  } catch {
    return null;
  }
}

const who = async () => {
  const u = await authUserOrNull();
  return u?.id && u.email ? { id: u.id, owner: isOwner(u.email) } : null;
};

const deps: HistoryDeps = {
  who,
  // `lianki chat` tokens (lib/api-tokens.ts): a Bearer token with chat:read reads its
  // own account's history; no backfill on a token's read. Otherwise the session.
  reader: async (req) => {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!bearer) return who();
    if (dbBackend() !== "d1") return null;
    const r = await checkToken(getD1() as unknown as D1Like, bearer, "chat:read");
    return r.ok ? { id: r.user.id, owner: false } : null;
  },
  db: () => (dbBackend() === "d1" ? (getD1() as unknown as ChatLogDb) : null),
  backfill: async () => {
    const p = push();
    if (!p) return null;
    const res = await p.fetch("https://lianki-push/internal/chat-backfill", { method: "POST" });
    if (!res.ok) throw new Error(`lianki-push backfill: ${res.status} ${await res.text()}`);
    return res.json();
  },
};

export const GET = (req: Request) => getHistory(req, deps);
export const DELETE = (req: Request) => deleteHistory(req, deps);
